const APOSTROPHE_PATTERN = /[’‘`´]/gu;
const DASH_PATTERN = /[‐‑‒–—]/gu;
const NAME_PUNCTUATION_PATTERN = /['-]/gu;

export const MAX_NAME_SUGGESTIONS = 6;

export function normalizedNameSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(APOSTROPHE_PATTERN, "'")
    .replace(DASH_PATTERN, '-')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/\s*(['-])\s*/gu, '$1')
    .toLocaleLowerCase('en-US');
}

function nameSearchParts(value) {
  const normalized = normalizedNameSearchText(value);
  return Object.freeze({
    normalized,
    words: normalized.replace(NAME_PUNCTUATION_PATTERN, ' ').split(' ').filter(Boolean),
    compactWords: normalized.split(' ').map(word => word.replace(NAME_PUNCTUATION_PATTERN, '')),
    compact: normalized.replace(/[\s'-]/gu, '')
  });
}

function suggestionRank(name, query) {
  const nameParts = nameSearchParts(name);
  const queryParts = nameSearchParts(query);
  if (!nameParts.normalized || !queryParts.normalized) return Number.POSITIVE_INFINITY;
  if (nameParts.normalized === queryParts.normalized) return 0;
  if (nameParts.normalized.startsWith(queryParts.normalized)) return 1;

  if (
    queryParts.compact
    && nameParts.compactWords.some(word => word.startsWith(queryParts.compact))
  ) return 2;

  if (
    queryParts.words.length > 1
    && queryParts.words.every(queryWord => (
      nameParts.words.some(nameWord => nameWord.startsWith(queryWord))
    ))
  ) return 3;

  if (nameParts.words.some(word => word.startsWith(queryParts.normalized))) return 4;
  if (nameParts.normalized.includes(queryParts.normalized)) return 5;
  if (queryParts.compact && nameParts.compact.includes(queryParts.compact)) return 6;
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
