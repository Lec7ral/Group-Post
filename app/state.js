/* Shared in-memory state for the dashboard. chrome.storage.local is the
   single source of truth; this module mirrors it and notifies views. */

import {
  KEYS,
  getSettings,
  readGroups,
  readGroupStats,
  readLists,
  readCampaigns,
  readLog,
  getRun
} from "../shared/store.js";

export const state = {
  settings: {},
  groups: [],
  groupStats: {},
  lists: [],
  campaigns: [],
  log: [],
  run: {},
  ready: false
};

const subscribers = new Set();

export const subscribe = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

const emit = (changes) => {
  for (const fn of Array.from(subscribers)) {
    try {
      fn(changes);
    } catch (error) {
      console.error("view listener failed", error);
    }
  }
};

export async function loadAll() {
  const [settings, groups, groupStats, lists, campaigns, log, run] = await Promise.all([
    getSettings(),
    readGroups(),
    readGroupStats(),
    readLists(),
    readCampaigns(),
    readLog(),
    getRun()
  ]);
  Object.assign(state, { settings, groups, groupStats, lists, campaigns, log, run, ready: true });
  emit({ all: true });
  return state;
}

export function handleStorageChanges(changes) {
  const changed = {};
  if (changes[KEYS.settings]) {
    state.settings = changes[KEYS.settings].newValue || state.settings;
    changed.settings = true;
  }
  if (changes[KEYS.groups]) {
    state.groups = changes[KEYS.groups].newValue || [];
    changed.groups = true;
  }
  if (changes[KEYS.groupStats]) {
    state.groupStats = changes[KEYS.groupStats].newValue || {};
    changed.groupStats = true;
  }
  if (changes[KEYS.lists]) {
    state.lists = changes[KEYS.lists].newValue || [];
    changed.lists = true;
  }
  if (changes[KEYS.campaigns]) {
    state.campaigns = changes[KEYS.campaigns].newValue || [];
    changed.campaigns = true;
  }
  if (changes[KEYS.log]) {
    state.log = changes[KEYS.log].newValue || [];
    changed.log = true;
  }
  if (changes[KEYS.run]) {
    state.run = changes[KEYS.run].newValue || {};
    changed.run = true;
  }
  if (Object.keys(changed).length) emit(changed);
}

export const groupById = (id) => state.groups.find((group) => group.id === id) || null;
export const campaignById = (id) => state.campaigns.find((campaign) => campaign.id === id) || null;
