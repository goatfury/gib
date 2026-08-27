import {
  brandingForInstallation,
  MAX_NAME_SUGGESTIONS,
  usefulNameSuggestions
} from './kiosk-enhancements-core.mjs';

const profile = globalThis.M1_INSTALLATION_PROFILE;
const SUGGESTION_LIST_ID = 'm1NameSuggestions';
const NAME_HELP_ID = 'm1NameHelp';

function rosterNames(datalist) {
  return Array.from(datalist?.querySelectorAll('option') || [])
    .map(option => option.value || option.textContent || '')
    .filter(Boolean);
}

function initNameEntry() {
  const input = document.getElementById('nameInput');
  if (!(input instanceof HTMLInputElement)) return;

  const datalistId = input.getAttribute('list') || 'nameDatalist';
  const datalist = document.getElementById(datalistId);

  // The native datalist is the interaction that Silk expands to a full-screen list.
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('placeholder', 'Start typing your name');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', SUGGESTION_LIST_ID);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-describedby', NAME_HELP_ID);
  if (datalist) datalist.hidden = true;

  const field = input.parentElement;
  if (!field) return;
  field.classList.add('m1-name-field');

  const help = document.createElement('div');
  help.id = NAME_HELP_ID;
  help.className = 'm1-name-help';
  help.textContent = "Don’t see your name? Just type it.";

  const list = document.createElement('div');
  list.id = SUGGESTION_LIST_ID;
  list.className = 'm1-name-suggestions';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Instructor name suggestions');
  list.hidden = true;

  input.insertAdjacentElement('afterend', help);
  help.insertAdjacentElement('afterend', list);

  let activeIndex = -1;
  let currentSuggestions = [];

  function closeSuggestions() {
    list.hidden = true;
    list.replaceChildren();
    currentSuggestions = [];
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function setActive(index) {
    if (!currentSuggestions.length) return;
    activeIndex = (index + currentSuggestions.length) % currentSuggestions.length;
    Array.from(list.children).forEach((element, optionIndex) => {
      const selected = optionIndex === activeIndex;
      element.setAttribute('aria-selected', String(selected));
      element.classList.toggle('active', selected);
      if (selected) {
        input.setAttribute('aria-activedescendant', element.id);
        element.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function selectSuggestion(value) {
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closeSuggestions();
    input.focus({ preventScroll: true });
  }

  function renderSuggestions() {
    if (!input.value.trim()) {
      closeSuggestions();
      return;
    }

    currentSuggestions = usefulNameSuggestions(
      rosterNames(datalist),
      input.value,
      MAX_NAME_SUGGESTIONS
    );
    if (!currentSuggestions.length) {
      closeSuggestions();
      return;
    }

    list.replaceChildren(...currentSuggestions.map((name, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `${SUGGESTION_LIST_ID}-${index}`;
      option.className = 'm1-name-suggestion';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.textContent = name;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => selectSuggestion(name));
      return option;
    }));
    activeIndex = -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
  }

  input.addEventListener('input', renderSuggestions);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeSuggestions();
      return;
    }
    if (list.hidden || !currentSuggestions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(activeIndex < 0 ? currentSuggestions.length - 1 : activeIndex - 1);
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      selectSuggestion(currentSuggestions[activeIndex]);
    }
  });

  document.addEventListener('pointerdown', event => {
    if (!field.contains(event.target)) closeSuggestions();
  }, { passive: true });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSuggestions();
  });

  for (const buttonId of ['btnSignIn', 'btnResetKiosk', 'btnKiosk', 'btnAdmin']) {
    document.getElementById(buttonId)?.addEventListener('click', closeSuggestions, { capture: true });
  }

  if (datalist) {
    new MutationObserver(() => {
      if (!list.hidden && input.value.trim()) renderSuggestions();
    }).observe(datalist, { childList: true, subtree: true, attributes: true });
  }
}

function initBranding() {
  const branding = brandingForInstallation(profile);
  const header = document.querySelector('.container > header');
  if (!branding || !header || document.querySelector('.m1-kiosk-brand')) return;

  const brand = document.createElement('div');
  brand.className = `m1-kiosk-brand ${branding.className}`;

  const image = document.createElement('img');
  image.src = branding.src;
  image.alt = branding.alt;
  image.width = 240;
  image.height = 96;
  image.decoding = 'async';
  image.fetchPriority = 'high';
  brand.appendChild(image);

  header.insertBefore(brand, header.firstChild);
}

function init() {
  initBranding();
  initNameEntry();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
