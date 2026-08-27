const APOSTROPHE_PATTERN = /[’‘`´]/gu;
const DASH_PATTERN = /[‐‑‒–—]/gu;

export const MAX_NAME_SUGGESTIONS = 6;

export function normalizedNameSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(APOSTROPHE_PATTERN, "'")
    .replace(DASH_PATTERN, '-')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

function suggestionRank(name, query) {
  const normalizedName = normalizedNameSearchText(name);
  if (!normalizedName || !query) return Number.POSITIVE_INFINITY;
  if (normalizedName === query) return 0;
  if (normalizedName.startsWith(query)) return 1;

  const nameWords = normalizedName.split(' ');
  if (nameWords.some(word => word.startsWith(query))) return 2;

  const queryWords = query.split(' ').filter(Boolean);
  if (
    queryWords.length > 1
    && queryWords.every(word => nameWords.some(nameWord => nameWord.startsWith(word)))
  ) return 3;

  if (normalizedName.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function usefulNameSuggestions(names, query, limit = MAX_NAME_SUGGESTIONS) {
  const normalizedQuery = normalizedNameSearchText(query);
  if (!normalizedQuery) return [];

  const safeLimit = Math.max(0, Math.min(MAX_NAME_SUGGESTIONS, Number(limit) || 0));
  if (!safeLimit) return [];

  const seen = new Set();
  return (Array.isArray(names) ? names : [])
    .map((value, index) => ({
      value: String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/gu, ' '),
      index
    }))
    .filter(item => {
      const key = normalizedNameSearchText(item.value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(item => ({
      ...item,
      rank: suggestionRank(item.value, normalizedQuery),
      normalized: normalizedNameSearchText(item.value)
    }))
    .filter(item => Number.isFinite(item.rank))
    .sort((left, right) => (
      left.rank - right.rank
      || left.normalized.localeCompare(right.normalized, 'en-US')
      || left.index - right.index
    ))
    .slice(0, safeLimit)
    .map(item => item.value);
}

export function brandingForInstallation(profile) {
  if (profile?.installationId === 'rev') {
    return Object.freeze({
      src: './assets/revolution-bjj-logo.webp',
      alt: 'Revolution BJJ logo',
      className: 'm1-kiosk-brand-rev'
    });
  }
  if (profile?.installationId === 'richmond') {
    return Object.freeze({
      src: './assets/richmond-bjj-logo.webp',
      alt: 'Richmond Brazilian Jiu-Jitsu and Self-Defense Academy logo',
      className: 'm1-kiosk-brand-richmond'
    });
  }
  return null;
}
