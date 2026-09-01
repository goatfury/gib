#!/usr/bin/env python3
"""Build the Oil Atlas refined-products snapshot from official JODI secondary data."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen
import csv
import io
import json
import math
import re

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "refined-products" / "refined-products-data.json"
DOWNLOAD_PAGE = "https://www.jodidata.org/oil/database/data-downloads.aspx"
USER_AGENT = "Oil-Flow-Atlas/1.0 (+https://oil-flow-atlas.netlify.app)"


def normal(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag.lower() != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self.links.append(href)


def download(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    with urlopen(request, timeout=90) as response:
        return response.read().decode("utf-8-sig", errors="replace")


def discover_secondary_urls() -> list[str]:
    parser = LinkParser()
    parser.feed(download(DOWNLOAD_PAGE))
    current_year = datetime.now(timezone.utc).year
    years = {str(current_year), str(current_year - 1)}
    urls = []
    for href in parser.links:
        low = href.lower()
        if "annual-csv" not in low or "secondary" not in low:
            continue
        if not any(year in low for year in years):
            continue
        urls.append(urljoin(DOWNLOAD_PAGE, href))
    urls = sorted(set(urls))
    if not urls:
        raise RuntimeError("JODI secondary annual CSV links were not found")
    return urls


def read_csv(text: str) -> list[dict[str, str]]:
    try:
        dialect = csv.Sniffer().sniff(text[:12000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return list(csv.DictReader(io.StringIO(text), dialect=dialect))


def select_column(columns: list[str], tokens: tuple[str, ...], prefer_name: bool = False) -> str | None:
    choices = []
    for column in columns:
        key = normal(column)
        score = 0
        for token in tokens:
            if key == token:
                score += 20
            elif token in key:
                score += 5
        if prefer_name and ("name" in key or "label" in key):
            score += 8
        if score:
            choices.append((score, -len(key), column))
    return max(choices)[2] if choices else None


def best_label(rows: list[dict[str, str]], columns: list[str], terms: tuple[str, ...]) -> str:
    best = None
    for column in columns:
        values = [str(row.get(column, "")).strip() for row in rows[:50000] if str(row.get(column, "")).strip()]
        if not values:
            continue
        unique = set(values[:10000])
        score = 100 * sum(any(term in normal(value) for term in terms) for value in unique)
        score += 3 if "name" in normal(column) or "label" in normal(column) else 0
        score += sum(any(char.isalpha() for char in value) for value in values[:1000]) / 1000
        if best is None or score > best[0]:
            best = (score, column)
    if best is None:
        raise RuntimeError(f"No label column found among {columns}")
    return best[1]


def parse_period(value: object) -> str | None:
    text = str(value or "").strip()
    match = re.search(r"(20\d{2})\D?(0[1-9]|1[0-2])", text)
    if match:
        return f"{match.group(1)}-{match.group(2)}"
    digits = re.sub(r"\D", "", text)
    match = re.fullmatch(r"(20\d{2})([1-9]|1[0-2])", digits)
    if match:
        return f"{match.group(1)}-{int(match.group(2)):02d}"
    return None


def number(value: object) -> float | None:
    try:
        text = str(value).strip().replace(",", "")
        if not text or text.lower() in {"nan", "null", "na", "..", "-"}:
            return None
        result = float(text)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def to_mbd(value: object, unit: object) -> float | None:
    amount = number(value)
    if amount is None:
        return None
    key = normal(unit)
    if ("thousand" in key and "barrel" in key) or key in {"kbd", "kb d", "kd"}:
        return amount / 1000
    if ("million" in key and "barrel" in key) or key in {"mb d", "mbd"}:
        return amount
    if "barrel" in key and "day" in key:
        return amount / 1_000_000
    return amount / 1000


def flow_kind(value: object) -> str | None:
    key = normal(value)
    if "export" in key:
        return "exports"
    if "import" in key:
        return "imports"
    if "refinery" in key and ("output" in key or "production" in key):
        return "output"
    if "product supplied" in key or "products supplied" in key or "demand" in key or "consumption" in key:
        return "demand"
    if "refinery" in key and ("intake" in key or "input" in key or "throughput" in key):
        return "intake"
    return None


def is_crude(value: object) -> bool:
    key = normal(value)
    return any(token in key for token in ("crude", "condensate", "natural gas liquid")) or key in {"ngl", "total oil"}


def total_score(value: object) -> int:
    key = normal(value)
    score = (10 if "total" in key else 0) + (8 if "product" in key else 0) + (3 if "petroleum" in key else 0)
    if is_crude(value):
        score -= 30
    if any(token in key for token in ("feedstock", "additive", "biofuel")):
        score -= 5
    return score


def main() -> None:
    raw_rows: list[dict[str, str]] = []
    urls = discover_secondary_urls()
    for url in urls:
        raw_rows.extend(read_csv(download(url)))
    if not raw_rows:
        raise RuntimeError("JODI secondary files contained no rows")

    columns = list(raw_rows[0])
    normalized = {column: normal(column) for column in columns}
    value_column = select_column(columns, ("obs value", "value", "quantity"))
    time_column = select_column(columns, ("time period", "time", "period", "date"))
    flow_columns = [column for column, key in normalized.items() if "flow" in key]
    product_columns = [column for column, key in normalized.items() if "product" in key and "flow" not in key]
    unit_columns = [column for column, key in normalized.items() if "unit" in key]
    country_columns = [column for column, key in normalized.items() if ("country" in key or "area" in key) and "parent" not in key]
    if not all((value_column, time_column, flow_columns, product_columns, country_columns)):
        raise RuntimeError(f"Unsupported JODI columns: {columns}")

    flow_column = best_label(raw_rows, flow_columns, ("export", "import", "refinery", "demand", "supplied"))
    product_column = best_label(raw_rows, product_columns, ("gasoline", "diesel", "fuel oil", "total product", "kerosene"))
    unit_column = best_label(raw_rows, unit_columns, ("barrel", "day", "kbd")) if unit_columns else None
    country_name_column = best_label(raw_rows, country_columns, ("united states", "saudi", "china", "india"))
    country_code_column = country_name_column
    for column in country_columns:
        values = [str(row.get(column, "")).strip() for row in raw_rows[:10000] if str(row.get(column, "")).strip()]
        if values and sum(len(value) in (2, 3) and value.isalpha() for value in values) / len(values) > 0.85:
            country_code_column = column
            break

    units = Counter(str(row.get(unit_column, "")).strip() for row in raw_rows if unit_column and str(row.get(unit_column, "")).strip())
    rate_units = [unit for unit in units if ("barrel" in normal(unit) and "day" in normal(unit)) or normal(unit) in {"kbd", "kb d", "kd", "mb d", "mbd"}]
    chosen_unit = max(rate_units, key=lambda unit: units[unit]) if rate_units else (units.most_common(1)[0][0] if units else "")

    product_counts = Counter(str(row.get(product_column, "")).strip() for row in raw_rows if str(row.get(product_column, "")).strip())
    total_product = next((product for product in sorted(product_counts, key=lambda p: (total_score(p), product_counts[p]), reverse=True) if total_score(product) >= 15), None)

    records = []
    first_period = f"{datetime.now(timezone.utc).year - 1}-01"
    for row in raw_rows:
        period = parse_period(row.get(time_column))
        if not period or period < first_period:
            continue
        flow = flow_kind(row.get(flow_column))
        product = str(row.get(product_column, "")).strip()
        if not flow or not product or is_crude(product):
            continue
        unit = str(row.get(unit_column, "")).strip() if unit_column else chosen_unit
        if chosen_unit and unit and unit != chosen_unit:
            continue
        value = to_mbd(row.get(value_column), unit)
        if value is None or value < 0:
            continue
        code = str(row.get(country_code_column, "")).strip().upper()
        name = str(row.get(country_name_column, "")).strip() or code
        records.append({"period": period, "flow": flow, "product": product, "code": code, "name": name, "value": value})
    if not records:
        raise RuntimeError("No usable refined-products records were found")

    total_records = [record for record in records if total_product and record["product"] == total_product]
    if not total_records:
        total_records = [record for record in records if "total" not in normal(record["product"])]

    totals = defaultdict(float)
    for record in total_records:
        totals[(record["period"], record["flow"], record["code"], record["name"])] += record["value"]
    global_month = defaultdict(lambda: defaultdict(float))
    country_month = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    for (period, flow, code, name), value in totals.items():
        global_month[period][flow] += value
        country_month[period][code]["name"] = name
        country_month[period][code][flow] += value
    months = sorted(global_month)
    if not months:
        raise RuntimeError("No refined-products months were generated")

    latest = months[-1]
    breakdown = defaultdict(float)
    for record in records:
        if record["period"] == latest and record["flow"] in {"output", "demand"} and "total" not in normal(record["product"]):
            breakdown[record["product"]] += record["value"]

    month_payload = []
    for period in months:
        countries = []
        for code, values in country_month[period].items():
            item = {"code": code, "name": values.get("name", code)}
            for key in ("output", "demand", "exports", "imports", "intake"):
                item[key] = round(float(values.get(key, 0)), 3)
            item["netExports"] = round(item["exports"] - item["imports"], 3)
            countries.append(item)
        countries.sort(key=lambda item: max(item["exports"], item["imports"], item["output"]), reverse=True)
        month_payload.append({
            "period": period,
            "global": {key: round(float(global_month[period].get(key, 0)), 3) for key in ("output", "demand", "exports", "imports", "intake")},
            "countries": countries[:55],
        })

    payload = {
        "schema": 1,
        "stream": "refined-products",
        "label": "Refined products",
        "source": "JODI Oil World Database — secondary products annual CSV",
        "sourceUrl": DOWNLOAD_PAGE,
        "sourceFiles": urls,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "latestPeriod": latest,
        "unit": "million barrels per day",
        "reportedProduct": total_product or "sum of reported component products",
        "reportedUnit": chosen_unit,
        "coverage": {"months": len(month_payload), "latestCountries": len(month_payload[-1]["countries"])},
        "months": month_payload,
        "productMix": [{"product": product, "mbd": round(value, 3)} for product, value in sorted(breakdown.items(), key=lambda item: item[1], reverse=True)[:10]],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(OUT), "latestPeriod": latest, "months": len(month_payload), "latestCountries": payload["coverage"]["latestCountries"]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        if OUT.exists() and OUT.stat().st_size > 1000:
            print("JODI refresh failed; retaining the checked-in refined-products snapshot")
        else:
            raise
