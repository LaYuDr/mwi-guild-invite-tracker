// ==UserScript==
// @name         银河奶牛公会邀请助手
// @name:en      MWI Guild Invite Tracker
// @namespace    https://github.com/layu/mwi-guild-invite-tracker
// @version      0.5.3
// @description  被动记录排行榜资料查看、公会状态和原生公会邀请结果
// @description:en Passively records leaderboard profile views, guild status, and native guild invite outcomes
// @match        https://www.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @run-at       document-start
// @grant        GM_addElement
// @license      MIT
// ==/UserScript==


// ---- src/runtime/config.js ----
(function initConfig(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  app.config = Object.freeze({
    appId: "mwi-guild-invite-tracker",
    version: "0.5.3",
    schemaVersion: 3,
    databaseName: "mwi-guild-invite-tracker",
    databaseVersion: 2,
    bridgeMarker: "__MWI_GUILD_INVITE_TRACKER_BRIDGE_V1__",
    bridgeEvent: "mwi-git:protocol:v1",
    uiPrefix: "mwi-git",
    settingsKey: "mwi-git:settings:v1",
    lastIdentityKey: "mwi-git:last-identity:v1",
    profileTimeoutMs: 15_000,
    leaderboardTimeoutMs: 15_000,
    inviteTimeoutMs: 15_000,
    duplicateWindowMs: 1_250,
    engagementWindowMs: 7 * 24 * 60 * 60 * 1000,
    maxImportBytes: 100 * 1024 * 1024,
    officialSocketHostPattern: /^api(?:-test)?\.milkywayidle(?:cn)?\.com$/i,
    observedTypes: Object.freeze([
      "init_character_data",
      "get_leaderboard",
      "leaderboard_updated",
      "view_profile",
      "profile_shared",
      "send_guild_invite",
      "info",
      "error",
      "guild_characters_updated"
    ])
  });
})(globalThis);

// ---- src/core.js ----
(function initCore(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  const OUTCOMES = new Set([
    "pending",
    "sent",
    "already_in_guild",
    "already_invited",
    "guild_full",
    "mode_mismatch",
    "not_found",
    "blocked",
    "rate_limited",
    "timeout",
    "ambiguous",
    "unknown_error"
  ]);

  const ACTIVITY_STATES = new Set(["work", "offline", "none"]);
  const ENGAGEMENT_STATES = new Set(["online", "offline"]);
  const PROFILE_METRIC_KEYS = Object.freeze([
    "totalLevel",
    "totalExperience",
    "combatLevel",
    "achievementsCompleted",
    "totalTaskPoints",
    "labyrinthPoints",
    "labyrinthHighestFloor",
    "labyrinthHighestFloorRooms",
    "collectionPoints",
    "bestiaryPoints",
    "famePoints"
  ]);

  const ERROR_OUTCOME = Object.freeze({
    "errorNotification.characterNameNotFound": "not_found",
    "errorNotification.characterAlreadyInGuild": "already_in_guild",
    "errorNotification.characterAlreadyInvited": "already_invited",
    "errorNotification.guildIsFull": "guild_full",
    "errorNotification.guildTypeMismatch": "mode_mismatch",
    "errorNotification.characterBlockError": "blocked",
    "errorNotification.requestSpamProtection": "rate_limited"
  });

  function normalizeName(value) {
    return typeof value === "string" ? value.trim().normalize("NFKC").toLocaleLowerCase() : "";
  }

  function safeString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }

  function nullableNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isoNow(clock) {
    return new Date(clock ? clock() : Date.now()).toISOString();
  }

  function uuid(randomUUID) {
    if (typeof randomUUID === "function") return randomUUID();
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function playerKey(characterId, name) {
    const id = nullableNumber(characterId);
    return id === null ? `name:${normalizeName(name)}` : `character:${id}`;
  }

  function guildSnapshot(profile, observedAt) {
    const guildId = nullableNumber(profile && profile.guildId);
    const guildName = safeString(profile && profile.guildName).trim() || null;
    const guildRole = safeString(profile && profile.guildRole).trim() || null;
    const joined = guildId !== null || Boolean(guildName) || Boolean(guildRole);
    return {
      state: joined ? "joined" : "none",
      guildId,
      guildName,
      guildRole,
      observedAt,
      certainty: "profile"
    };
  }

  function activitySnapshot(profile, observedAt) {
    const state = ACTIVITY_STATES.has(profile?.activityState) ? profile.activityState : "none";
    return {
      state,
      observedAt,
      certainty: "profile"
    };
  }

  function activityStateForObservation(event) {
    return ACTIVITY_STATES.has(event?.activitySnapshot?.state) ? event.activitySnapshot.state : "unrecorded";
  }

  function mergeAliases(existing, incoming, currentName) {
    const aliases = new Map();
    for (const value of [...(existing || []), ...(incoming || [])]) {
      if (!value || normalizeName(value) === normalizeName(currentName)) continue;
      aliases.set(normalizeName(value), value);
    }
    return [...aliases.values()];
  }

  function laterIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return Date.parse(a) >= Date.parse(b) ? a : b;
  }

  function mergePlayer(existing, incoming) {
    if (!existing) return { ...incoming, nameAliases: [...(incoming.nameAliases || [])] };
    const existingLatest = existing.latestGuild && existing.latestGuild.observedAt;
    const incomingLatest = incoming.latestGuild && incoming.latestGuild.observedAt;
    const useIncomingGuild = incomingLatest && (!existingLatest || Date.parse(incomingLatest) >= Date.parse(existingLatest));
    const currentName = incoming.currentName || existing.currentName;
    const aliases = mergeAliases(
      [...(existing.nameAliases || []), existing.currentName],
      [...(incoming.nameAliases || []), incoming.currentName],
      currentName
    );
    return {
      ...existing,
      ...incoming,
      playerKey: incoming.characterId != null ? playerKey(incoming.characterId, currentName) : existing.playerKey,
      characterId: incoming.characterId != null ? nullableNumber(incoming.characterId) : existing.characterId,
      currentName,
      normalizedName: normalizeName(currentName),
      nameAliases: aliases,
      firstSeenAt:
        Date.parse(existing.firstSeenAt) <= Date.parse(incoming.firstSeenAt)
          ? existing.firstSeenAt
          : incoming.firstSeenAt,
      lastSeenAt: laterIso(existing.lastSeenAt, incoming.lastSeenAt),
      lastViewedAt: laterIso(existing.lastViewedAt, incoming.lastViewedAt),
      lastInvitedAt: laterIso(existing.lastInvitedAt, incoming.lastInvitedAt),
      lastLeaderboardSeenAt: laterIso(existing.lastLeaderboardSeenAt, incoming.lastLeaderboardSeenAt),
      latestGuild: useIncomingGuild ? incoming.latestGuild : existing.latestGuild
    };
  }

  function playerFromProfile(profile, viewedAt) {
    const name = safeString(profile && profile.name).trim();
    const characterId = nullableNumber(profile && profile.characterId);
    return {
      playerKey: playerKey(characterId, name),
      characterId,
      currentName: name,
      normalizedName: normalizeName(name),
      nameAliases: [],
      firstSeenAt: viewedAt,
      lastSeenAt: viewedAt,
      latestGuild: guildSnapshot(profile, viewedAt),
      lastViewedAt: viewedAt,
      lastInvitedAt: null
    };
  }

  function playerFromLeaderboard(entry, capturedAt) {
    const currentName = safeString(entry && entry.name).trim();
    const characterId = nullableNumber(entry && entry.characterId);
    return {
      playerKey: playerKey(characterId, currentName),
      characterId,
      currentName,
      normalizedName: normalizeName(currentName),
      nameAliases: [],
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      latestGuild: {
        state: "unknown",
        guildId: null,
        guildName: null,
        guildRole: null,
        observedAt: null,
        certainty: null
      },
      lastViewedAt: null,
      lastInvitedAt: null,
      lastLeaderboardSeenAt: capturedAt
    };
  }

  function playerFromInvite(name, attemptedAt) {
    const currentName = safeString(name).trim();
    return {
      playerKey: playerKey(null, currentName),
      characterId: null,
      currentName,
      normalizedName: normalizeName(currentName),
      nameAliases: [],
      firstSeenAt: attemptedAt,
      lastSeenAt: attemptedAt,
      latestGuild: {
        state: "unknown",
        guildId: null,
        guildName: null,
        guildRole: null,
        observedAt: null,
        certainty: null
      },
      lastViewedAt: null,
      lastInvitedAt: attemptedAt
    };
  }

  function playerFromGuildMember(character, guild, observedAt) {
    const currentName = safeString(character && character.name).trim();
    const characterId = nullableNumber(character && character.characterId);
    return {
      playerKey: playerKey(characterId, currentName),
      characterId,
      currentName,
      normalizedName: normalizeName(currentName),
      nameAliases: [],
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      latestGuild: {
        state: "joined",
        guildId: nullableNumber(guild && guild.guildId),
        guildName: safeString(guild && guild.guildName).trim() || null,
        guildRole: safeString(character && character.role).trim() || null,
        observedAt,
        certainty: "guild_roster"
      },
      lastViewedAt: null,
      lastInvitedAt: null
    };
  }

  function makeObservation(profile, context, viewedAt, randomUUID) {
    const player = playerFromProfile(profile, viewedAt);
    return {
      id: uuid(randomUUID),
      playerKey: player.playerKey,
      characterName: player.currentName,
      viewedAt,
      source: context && context.leaderboard ? "leaderboard" : (context && context.source) || "unknown",
      leaderboard: context && context.leaderboard ? structuredCloneSafe(context.leaderboard) : null,
      guildSnapshot: guildSnapshot(profile, viewedAt),
      activitySnapshot: activitySnapshot(profile, viewedAt),
      presenceSnapshot: profile?.presenceSnapshot ? structuredCloneSafe(profile.presenceSnapshot) : null,
      progressSnapshot: profile?.progressSnapshot ? structuredCloneSafe(profile.progressSnapshot) : null
    };
  }

  function makeInviteEvent(name, attemptedAt, recruiter, linkedObservationId, randomUUID) {
    const normalizedName = normalizeName(name);
    return {
      id: uuid(randomUUID),
      playerKey: playerKey(null, name),
      requestedName: safeString(name).trim(),
      normalizedName,
      attemptedAt,
      confirmedAt: null,
      detectedAt: null,
      outcome: "pending",
      errorKey: null,
      correlation: null,
      source: "native_guild_form",
      recruiter: recruiter ? structuredCloneSafe(recruiter) : null,
      linkedObservationId: linkedObservationId || null
    };
  }

  function applyInviteOutcome(event, outcome, confirmedAt, correlation, errorKey) {
    const safeOutcome = OUTCOMES.has(outcome) ? outcome : "unknown_error";
    if (!event || event.outcome !== "pending") return event;
    return {
      ...event,
      outcome: safeOutcome,
      confirmedAt: confirmedAt || null,
      errorKey: errorKey || null,
      correlation: correlation || null
    };
  }

  function outcomeFromErrorKey(key) {
    return ERROR_OUTCOME[key] || "unknown_error";
  }

  function structuredCloneSafe(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isIsoDate(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }

  function latestInviteForPlayer(events, key) {
    return (events || [])
      .filter((event) => event.playerKey === key)
      .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt))[0] || null;
  }

  function canonicalList(value) {
    return Array.isArray(value)
      ? [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : null;
  }

  function positiveDelta(previous, current) {
    const before = nullableNumber(previous);
    const after = nullableNumber(current);
    return before !== null && after !== null && after > before ? after - before : null;
  }

  function profileEvidenceBetween(previous, current) {
    const before = previous?.progressSnapshot;
    const after = current?.progressSnapshot;
    if (!before || !after) return { comparable: false, evidence: [] };
    const evidence = [];
    let comparable = false;
    for (const key of PROFILE_METRIC_KEYS) {
      if (nullableNumber(before.metrics?.[key]) !== null && nullableNumber(after.metrics?.[key]) !== null) comparable = true;
      const delta = positiveDelta(before.metrics?.[key], after.metrics?.[key]);
      if (delta !== null) evidence.push({ source: "profile", kind: "metric", key, delta, at: current.viewedAt });
    }
    const compareCollections = (name, keyField, valueField) => {
      const beforeItems = Array.isArray(before[name]) ? before[name] : null;
      const afterItems = Array.isArray(after[name]) ? after[name] : null;
      if (!beforeItems || !afterItems) return;
      const previousMap = new Map(beforeItems.map((item) => [item[keyField], item]));
      for (const item of afterItems) {
        const earlier = previousMap.get(item[keyField]);
        if (earlier && nullableNumber(earlier[valueField]) !== null && nullableNumber(item[valueField]) !== null) comparable = true;
        const delta = positiveDelta(earlier?.[valueField], item[valueField]);
        if (delta !== null) {
          evidence.push({ source: "profile", kind: name, key: item[keyField], delta, at: current.viewedAt });
        }
      }
    };
    compareCollections("skills", "skillHrid", "experience");
    compareCollections("achievements", "achievementHrid", "progress");
    compareCollections("houseRooms", "roomHrid", "level");
    for (const name of ["equipment", "equippedAbilities"]) {
      const beforeItems = canonicalList(before[name]);
      const afterItems = canonicalList(after[name]);
      if (beforeItems && afterItems) {
        comparable = true;
        if (JSON.stringify(beforeItems) !== JSON.stringify(afterItems)) {
          evidence.push({ source: "profile", kind: `${name}_changed`, key: name, delta: null, at: current.viewedAt });
        }
      }
    }
    return { comparable, evidence };
  }

  function leaderboardSeriesKey(entry) {
    return [entry?.typeHrid || "", entry?.categoryHrid || "", entry?.filterKey || ""].join("|");
  }

  function leaderboardExperienceValue(entry) {
    if (entry?.noGuildConfirmedAtCapture !== true) return null;
    return nullableNumber(entry.experienceValue);
  }

  function leaderboardEvidenceBetween(previous, current) {
    if (!previous || !current || leaderboardSeriesKey(previous) !== leaderboardSeriesKey(current)) {
      return { comparable: false, evidence: [] };
    }
    const before = leaderboardExperienceValue(previous);
    const after = leaderboardExperienceValue(current);
    if (before === null || after === null) return { comparable: false, evidence: [] };
    const delta = positiveDelta(before, after);
    const evidence = delta === null
      ? []
      : [{ source: "leaderboard", kind: "experience", key: current.categoryHrid || "experience", delta, at: current.capturedAt }];
    return { comparable: true, evidence };
  }

  const dataIndexCache = new WeakMap();

  function buildEngagementBase(entries) {
    const confirmed = (entries || [])
      .filter((entry) => entry.noGuildConfirmedAtCapture === true)
      .sort((a, b) => Date.parse(a.capturedAt || 0) - Date.parse(b.capturedAt || 0));
    const evidence = [];
    let comparisonCount = 0;
    const series = new Map();
    for (const entry of confirmed) {
      const key = leaderboardSeriesKey(entry);
      const previous = series.get(key);
      const result = leaderboardEvidenceBetween(previous, entry);
      if (result.comparable) comparisonCount += 1;
      evidence.push(...result.evidence);
      series.set(key, entry);
    }
    evidence.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
    return { entries: confirmed, evidence, comparisonCount };
  }

  function dataIndex(data) {
    const source = data && typeof data === "object" ? data : {};
    const cached = dataIndexCache.get(source);
    if (cached) return cached;
    const invites = new Map();
    const observationLists = new Map();
    const observations = new Map();
    const leaderboardEntryLists = new Map();
    const categories = new Map();
    const ranks = new Map();
    const categoryRanks = new Map();

    for (const event of source.inviteEvents || []) {
      const previous = invites.get(event.playerKey);
      if (!previous || Date.parse(event.attemptedAt || 0) > Date.parse(previous.attemptedAt || 0)) {
        invites.set(event.playerKey, event);
      }
    }
    for (const event of source.profileObservations || []) {
      if (!observationLists.has(event.playerKey)) observationLists.set(event.playerKey, []);
      observationLists.get(event.playerKey).push(event);
      const category = event.leaderboard?.categoryHrid;
      if (category) {
        if (!categories.has(event.playerKey)) categories.set(event.playerKey, new Set());
        categories.get(event.playerKey).add(category);
      }
      const rank = nullableNumber(event.leaderboard?.rank);
      if (rank !== null) {
        const current = ranks.get(event.playerKey);
        if (current === undefined || rank < current) ranks.set(event.playerKey, rank);
        if (category) {
          if (!categoryRanks.has(event.playerKey)) categoryRanks.set(event.playerKey, new Map());
          const playerRanks = categoryRanks.get(event.playerKey);
          const categoryRank = playerRanks.get(category);
          if (categoryRank === undefined || rank < categoryRank) playerRanks.set(category, rank);
        }
      }
    }
    for (const [playerKey, events] of observationLists) {
      events.sort((a, b) => Date.parse(b.viewedAt || 0) - Date.parse(a.viewedAt || 0));
      observations.set(playerKey, events[0]);
    }
    for (const entry of source.leaderboardEntries || []) {
      if (!leaderboardEntryLists.has(entry.playerKey)) leaderboardEntryLists.set(entry.playerKey, []);
      leaderboardEntryLists.get(entry.playerKey).push(entry);
      if (entry.categoryHrid) {
        if (!categories.has(entry.playerKey)) categories.set(entry.playerKey, new Set());
        categories.get(entry.playerKey).add(entry.categoryHrid);
      }
      const rank = nullableNumber(entry.rank);
      if (rank !== null) {
        const current = ranks.get(entry.playerKey);
        if (current === undefined || rank < current) ranks.set(entry.playerKey, rank);
        if (entry.categoryHrid) {
          if (!categoryRanks.has(entry.playerKey)) categoryRanks.set(entry.playerKey, new Map());
          const playerRanks = categoryRanks.get(entry.playerKey);
          const categoryRank = playerRanks.get(entry.categoryHrid);
          if (categoryRank === undefined || rank < categoryRank) playerRanks.set(entry.categoryHrid, rank);
        }
      }
    }
    const engagementBases = new Map();
    for (const [playerKey, entries] of leaderboardEntryLists) {
      engagementBases.set(playerKey, buildEngagementBase(entries));
    }
    const index = {
      invites,
      observationLists,
      observations,
      leaderboardEntryLists,
      categories,
      ranks,
      categoryRanks,
      engagementBases
    };
    dataIndexCache.set(source, index);
    return index;
  }

  function engagementAssessment(player, _observations, leaderboardEntries, now = Date.now(), options = {}) {
    const windowMs = Number(options.windowMs) || app.config.engagementWindowMs;
    if (player?.latestGuild?.state !== "none") return { state: "not_applicable", evidence: [], comparisonCount: 0 };
    const base = options.dataIndex
      ? options.dataIndex.engagementBases.get(player.playerKey) || { entries: [], evidence: [], comparisonCount: 0 }
      : buildEngagementBase((leaderboardEntries || []).filter((entry) => entry.playerKey === player.playerKey));
    const { entries, evidence, comparisonCount } = base;
    const recentEvidence = evidence.find((item) => now - Date.parse(item.at || 0) <= windowMs) || null;
    if (recentEvidence) {
      return { state: "online", evidence, latestEvidence: recentEvidence, comparisonCount };
    }
    if (entries.length >= 1) return { state: "offline", evidence, latestEvidence: null, comparisonCount };
    return { state: "insufficient", evidence, latestEvidence: null, comparisonCount };
  }

  function playerStatus(player, invite) {
    if (player.latestGuild && player.latestGuild.state === "joined") return "has_guild";
    if (invite && ["pending", "sent"].includes(invite.outcome)) return "invited";
    if (player.latestGuild && player.latestGuild.state === "none") return "no_guild";
    return "unknown";
  }

  function filterPlayers(players, options, invites, observations, leaderboardEntries, existingIndex = null, now = Date.now()) {
    const query = normalizeName(options && options.query);
    const status = options && options.status;
    const guildState = options && options.guildState;
    const inviteOutcome = options && options.inviteOutcome;
    const activityState = options && options.activityState;
    const engagementState = options && options.engagementState;
    const category = options && options.category;
    const days = Number(options && options.days) || 0;
    const sort = (options && options.sort) || "lastViewedAt";
    const direction = options && options.direction === "asc" ? 1 : -1;
    const index = existingIndex || dataIndex({
      players: players || [],
      inviteEvents: invites || [],
      profileObservations: observations || [],
      leaderboardEntries: leaderboardEntries || []
    });
    const cutoff = days ? now - days * 24 * 60 * 60 * 1000 : 0;
    return (players || [])
      .filter((player) => {
        const haystack = [player.currentName, ...(player.nameAliases || [])].map(normalizeName);
        if (query && !haystack.some((name) => name.includes(query))) return false;
        const invite = index.invites.get(player.playerKey);
        if (status && status !== "all" && playerStatus(player, invite) !== status) return false;
        if (guildState && guildState !== "all" && player.latestGuild?.state !== guildState) return false;
        if (inviteOutcome && inviteOutcome !== "all" && invite?.outcome !== inviteOutcome) return false;
        const playerObservations = index.observationLists.get(player.playerKey) || [];
        const latestActivityState = activityStateForObservation(playerObservations[0]);
        if (activityState && activityState !== "all" && latestActivityState !== activityState) return false;
        const assessment = engagementAssessment(player, playerObservations, leaderboardEntries, now, { dataIndex: index });
        if (engagementState && engagementState !== "all" && assessment.state !== engagementState) return false;
        if (
          category && category !== "all" &&
          !index.categories.get(player.playerKey)?.has(category)
        ) return false;
        if (cutoff) {
          const latestActivity = Math.max(Date.parse(player.lastViewedAt || 0) || 0, Date.parse(player.lastInvitedAt || 0) || 0);
          if (latestActivity < cutoff) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sort === "name") return direction * a.currentName.localeCompare(b.currentName);
        if (sort === "rank") {
          const rankFor = (player) => category && category !== "all"
            ? index.categoryRanks.get(player.playerKey)?.get(category) ?? Number.POSITIVE_INFINITY
            : index.ranks.get(player.playerKey) ?? Number.POSITIVE_INFINITY;
          return direction * (rankFor(a) - rankFor(b));
        }
        const aValue = Date.parse(a[sort] || 0) || 0;
        const bValue = Date.parse(b[sort] || 0) || 0;
        return direction * (aValue - bValue);
      });
  }

  app.core = Object.freeze({
    OUTCOMES,
    ACTIVITY_STATES,
    ENGAGEMENT_STATES,
    PROFILE_METRIC_KEYS,
    ERROR_OUTCOME,
    normalizeName,
    nullableNumber,
    isoNow,
    uuid,
    playerKey,
    guildSnapshot,
    activitySnapshot,
    activityStateForObservation,
    mergePlayer,
    laterIso,
    playerFromProfile,
    playerFromLeaderboard,
    playerFromInvite,
    playerFromGuildMember,
    makeObservation,
    makeInviteEvent,
    applyInviteOutcome,
    outcomeFromErrorKey,
    isIsoDate,
    latestInviteForPlayer,
    profileEvidenceBetween,
    leaderboardEvidenceBetween,
    leaderboardExperienceValue,
    dataIndex,
    engagementAssessment,
    playerStatus,
    filterPlayers,
    structuredCloneSafe
  });
})(globalThis);

// ---- src/localization.js ----
(function initLocalization(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const messages = {
    zh: {
      launcher: "邀请",
      sidebar: "邀请",
      title: "邀请",
      subtitle: "招募记录",
      close: "关闭",
      settings: "显示设置",
      indicatorLocations: "指示器显示",
      showOnLeaderboards: "排行榜",
      showInChat: "聊天室",
      search: "搜索玩家",
      allStatuses: "全部状态",
      allGuildStates: "全部公会状态",
      allActivityStates: "全部活动状态",
      allEngagementStates: "全部游玩判断",
      allCategories: "全部排行榜",
      allInviteOutcomes: "全部邀请结果",
      allTime: "全部时间",
      last7Days: "最近 7 天",
      last30Days: "最近 30 天",
      last90Days: "最近 90 天",
      noGuild: "无公会",
      hasGuild: "有公会",
      ownGuild: "本公会成员",
      notChecked: "未查询",
      activityWork: "工作",
      activityOffline: "离线",
      activityNone: "无",
      activityUnrecorded: "无记录",
      engagementOnline: "在线（仍在游玩）",
      engagementOffline: "离线（未检测到仍在游玩）",
      engagementInsufficient: "尚无排行榜经验快照",
      engagementNotApplicable: "已有公会 · 不判断",
      engagementEvidenceLeaderboard: "7 天内排行榜经验增加",
      leaderboardCaptured: "记录排行榜",
      noGuildActivityUnrecorded: "无公会 · 在线数据无记录",
      guildStatus: "公会状态",
      inviting: "邀请中",
      invited: "已邀请",
      inviteFailed: "邀请失败",
      unknown: "未确认",
      sortRecentView: "最近查看",
      sortRecentInvite: "最近邀请",
      sortName: "玩家名称",
      sortRank: "最佳排名",
      exportJson: "导出备份",
      exportCsv: "导出表格",
      importJson: "导入",
      clear: "清空记录",
      deletePlayer: "删除记录",
      filtersSection: "筛选",
      dataSection: "备份与数据",
      expandSection: "展开",
      collapseSection: "折叠",
      players: "候选人",
      observations: "查看记录",
      invites: "邀请记录",
      timeline: "时间线",
      emptyPlayers: "还没有记录。先在排行榜打开一名玩家的详细资料。",
      emptyTimeline: "选择一名玩家查看记录。",
      viewed: "查看资料",
      inviteAttempt: "提交邀请",
      guildNone: "无公会",
      guildUnknown: "公会未知",
      rank: "排名",
      checkedAt: "检查于",
      outcome: "结果",
      pending: "等待确认",
      sent: "邀请成功",
      already_in_guild: "玩家已有公会",
      already_invited: "已经邀请过",
      guild_full: "公会已满",
      mode_mismatch: "游戏模式不匹配",
      not_found: "玩家不存在",
      blocked: "无法邀请该玩家",
      rate_limited: "操作过于频繁",
      timeout: "服务器响应超时",
      ambiguous: "结果无法可靠关联",
      unknown_error: "未知错误",
      importTitle: "导入备份",
      importPreview: "导入预览",
      sourceCharacter: "来源角色",
      sourceSite: "来源站点",
      exportedAt: "导出时间",
      duplicate: "重复",
      merge: "智能合并",
      addOnly: "仅添加新数据",
      replace: "完全替换",
      confirmImport: "确认导入",
      cancel: "取消",
      importWarning: "来源角色或站点不同，请确认是否继续。",
      importSuccess: "导入完成",
      importFailed: "导入失败，现有数据没有改变。",
      invalidBackup: "备份文件格式或数据不正确。",
      confirmClear: "确定清空当前角色的全部招募记录吗？此操作不可撤销。",
      confirmDelete: "确定删除这名玩家及其全部查看和邀请记录吗？",
      waitIdentity: "等待识别角色",
      localOnly: "本地保存",
      language: "切换语言"
    },
    en: {
      launcher: "Recruitment archive",
      sidebar: "Recruiting",
      title: "Recruitment archive",
      subtitle: "Leaderboard views and guild invitations",
      close: "Close",
      search: "Search players",
      allStatuses: "All statuses",
      allGuildStates: "All guild states",
      allActivityStates: "All profile presence states",
      allEngagementStates: "All play assessments",
      allCategories: "All leaderboards",
      allInviteOutcomes: "All invite outcomes",
      allTime: "All time",
      last7Days: "Last 7 days",
      last30Days: "Last 30 days",
      last90Days: "Last 90 days",
      noGuild: "No guild",
      hasGuild: "Has guild",
      ownGuild: "Your guild member",
      notChecked: "Not checked",
      activityWork: "Activity shown",
      activityOffline: "Offline",
      activityNone: "None",
      activityUnrecorded: "Not recorded",
      engagementOnline: "Online (still playing)",
      engagementOffline: "Offline (no evidence of continued play)",
      engagementInsufficient: "No leaderboard experience snapshot yet",
      engagementNotApplicable: "In a guild · not assessed",
      engagementEvidenceLeaderboard: "Leaderboard experience increased within 7 days",
      leaderboardCaptured: "Leaderboard captured",
      guildStatus: "Guild status",
      inviting: "Invitation pending",
      invited: "Invited",
      inviteFailed: "Invite failed",
      unknown: "Unconfirmed",
      sortRecentView: "Recently viewed",
      sortRecentInvite: "Recently invited",
      sortName: "Player name",
      sortRank: "Best rank",
      exportJson: "Export full backup",
      exportCsv: "Export CSV",
      importJson: "Import backup",
      clear: "Clear this character",
      deletePlayer: "Delete this player's records",
      players: "Candidates",
      observations: "Views",
      invites: "Invites",
      timeline: "Timeline",
      emptyPlayers: "No records yet. Open a player's profile from a leaderboard.",
      emptyTimeline: "Select a player to see the complete timeline.",
      viewed: "Viewed profile",
      inviteAttempt: "Invitation submitted",
      guildNone: "No guild",
      guildUnknown: "Guild unknown",
      rank: "Rank",
      checkedAt: "Checked",
      outcome: "Result",
      pending: "Awaiting confirmation",
      sent: "Invite sent",
      already_in_guild: "Player already has a guild",
      already_invited: "Already invited",
      guild_full: "Guild is full",
      mode_mismatch: "Game mode mismatch",
      not_found: "Player not found",
      blocked: "Cannot invite this player",
      rate_limited: "Too many requests",
      timeout: "Server response timed out",
      ambiguous: "Result could not be correlated reliably",
      unknown_error: "Unknown error",
      importTitle: "Import backup",
      importPreview: "Import preview",
      merge: "Smart merge",
      addOnly: "Add new data only",
      replace: "Replace all",
      confirmImport: "Import",
      cancel: "Cancel",
      importWarning: "This backup is from another character or site. Confirm before continuing.",
      importSuccess: "Import complete",
      importFailed: "Import failed. Existing data was not changed.",
      invalidBackup: "The backup format or data is invalid.",
      confirmClear: "Clear all recruitment records for this character? This cannot be undone.",
      confirmDelete: "Delete this player and all related view and invite records?",
      waitIdentity: "Waiting for the game to identify this character. Refresh the game after first install.",
      localOnly: "Data stays in this browser",
      language: "Switch language"
    }
  };

  const leaderboardCategoryNames = Object.freeze({
    zh: Object.freeze({
      total_level: "总等级",
      milking: "挤奶",
      foraging: "采集",
      woodcutting: "伐木",
      cheesesmithing: "奶酪制作",
      crafting: "制作",
      tailoring: "缝纫",
      cooking: "烹饪",
      brewing: "酿造",
      alchemy: "炼金",
      enhancing: "强化",
      stamina: "耐力",
      intelligence: "智力",
      attack: "攻击",
      defense: "防御",
      melee: "近战",
      ranged: "远程",
      magic: "魔法",
      task_points: "任务点数",
      labyrinth_points: "迷宫点数",
      labyrinth_depth: "迷宫深度",
      collection_points: "收藏点数",
      bestiary_points: "图鉴点数",
      fame_points: "声望点数",
      guild: "公会等级",
      guild_buildings: "公会建筑",
      guild_shrines: "公会神殿",
      guild_points: "公会点数",
      guild_weekly_points: "公会每周点数",
      guild_weekly_trial: "公会每周试炼"
    }),
    en: Object.freeze({
      total_level: "Total Level",
      milking: "Milking",
      foraging: "Foraging",
      woodcutting: "Woodcutting",
      cheesesmithing: "Cheesesmithing",
      crafting: "Crafting",
      tailoring: "Tailoring",
      cooking: "Cooking",
      brewing: "Brewing",
      alchemy: "Alchemy",
      enhancing: "Enhancing",
      stamina: "Stamina",
      intelligence: "Intelligence",
      attack: "Attack",
      defense: "Defense",
      melee: "Melee",
      ranged: "Ranged",
      magic: "Magic",
      task_points: "Task Points",
      labyrinth_points: "Labyrinth Points",
      labyrinth_depth: "Labyrinth Depth",
      collection_points: "Collection Points",
      bestiary_points: "Bestiary Points",
      fame_points: "Fame Points",
      guild: "Level",
      guild_buildings: "Buildings",
      guild_shrines: "Shrines",
      guild_points: "Guild Points",
      guild_weekly_points: "Weekly Points",
      guild_weekly_trial: "Weekly Trials"
    })
  });

  const guildRoleNames = Object.freeze({
    zh: Object.freeze({
      leader: "会长",
      general: "将军",
      officer: "官员",
      member: "成员",
      applicant: "申请者",
      invited: "已邀请"
    }),
    en: Object.freeze({
      leader: "Leader",
      general: "General",
      officer: "Officer",
      member: "Member",
      applicant: "Applicant",
      invited: "Invited"
    })
  });

  const leaderboardTypeNames = Object.freeze({
    zh: Object.freeze({
      standard: "标准模式",
      steam_standard: "标准模式",
      ironman: "铁牛模式",
      steam_ironman: "铁牛模式"
    }),
    en: Object.freeze({
      standard: "Standard",
      steam_standard: "Standard",
      ironman: "Iron Cow",
      steam_ironman: "Iron Cow"
    })
  });

  function normalizedLanguage(value) {
    return String(value || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function detectLanguage() {
    try {
      const stored = root.localStorage?.getItem("i18nextLng");
      if (stored) return normalizedLanguage(stored);
    } catch (_error) {
      // The visible game language is used when localStorage is unavailable.
    }
    const tabLabels = Array.from(root.document?.querySelectorAll?.('[role="tab"]') || [])
      .map((tab) => String(tab.innerText || tab.textContent || "").trim());
    const sidebarLanguage = app.sidebarIntegration?.sidebarLocale?.(tabLabels);
    if (sidebarLanguage) return sidebarLanguage;
    return normalizedLanguage(root.document?.documentElement?.lang || root.navigator?.language);
  }

  function categoryName(hrid, language) {
    const key = String(hrid || "").trim();
    if (!key) return "?";
    return leaderboardCategoryNames[normalizedLanguage(language)][key] || key;
  }

  function mappedName(dictionary, value, language) {
    const key = String(value || "").trim().toLowerCase();
    if (!key) return "";
    return dictionary[normalizedLanguage(language)][key] || String(value);
  }

  function createI18n(initialLanguage) {
    let language = initialLanguage === "zh" || initialLanguage === "en" ? initialLanguage : detectLanguage();
    return {
      get language() {
        return language;
      },
      setLanguage(next) {
        language = normalizedLanguage(next);
      },
      t(key) {
        return messages[language][key] || messages.zh[key] || messages.en[key] || key;
      },
      category(hrid) {
        return categoryName(hrid, language);
      },
      guildRole(value) {
        return mappedName(guildRoleNames, value, language);
      },
      activityState(value) {
        const key = {
          work: "activityWork",
          offline: "activityOffline",
          none: "activityNone",
          unrecorded: "activityUnrecorded"
        }[value] || "activityUnrecorded";
        return messages[language][key] || messages.zh[key] || key;
      },
      engagementState(value) {
        const key = {
          online: "engagementOnline",
          offline: "engagementOffline",
          insufficient: "engagementInsufficient",
          not_applicable: "engagementNotApplicable"
        }[value] || "unknown";
        return messages[language][key] || messages.zh[key] || key;
      },
      evidence(item) {
        if (!item) return "";
        return item.source === "leaderboard" ? messages[language].engagementEvidenceLeaderboard : "";
      },
      leaderboardType(value) {
        return mappedName(leaderboardTypeNames, value, language);
      },
      summary(counts) {
        if (language === "zh") {
          return `${counts.players} 位候选 · ${counts.leaderboardCaptures || 0} 次榜单 · ${counts.observations} 次查看 · ${counts.invites} 次邀请`;
        }
        return `${counts.players} candidates · ${counts.leaderboardCaptures || 0} captures · ${counts.observations} views · ${counts.invites} invites`;
      },
      duplicateCount(count) {
        return language === "zh" ? `${messages.zh.duplicate} ${i18nNumber(count)} 条` : `${i18nNumber(count)} duplicate`;
      }
    };
  }

  function i18nNumber(value) {
    return Number.isFinite(Number(value)) ? String(Number(value)) : "0";
  }

  app.localization = Object.freeze({
    messages,
    leaderboardCategoryNames,
    guildRoleNames,
    leaderboardTypeNames,
    normalizedLanguage,
    detectLanguage,
    categoryName,
    createI18n
  });
})(globalThis);

// ---- src/bridge.js ----
(function initBridge(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  function pageBridgeInstaller(options) {
    "use strict";

    if (window[options.marker]) return;
    Object.defineProperty(window, options.marker, { value: true, configurable: false });

    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== "function") return;
    const observed = new Set(options.observedTypes);
    const officialHost = /^api(?:-test)?\.milkywayidle(?:cn)?\.com$/i;

    function isOfficial(url) {
      try {
        const parsed = new URL(String(url), location.href);
        return parsed.protocol === "wss:" && officialHost.test(parsed.hostname);
      } catch (_error) {
        return false;
      }
    }

    function asObject(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function cleanVariables(value) {
      if (!Array.isArray(value)) return [];
      return value.slice(0, 20).map((entry) => ({
        name: typeof entry?.name === "string" ? entry.name : "",
        data:
          typeof entry?.data === "string" || typeof entry?.data === "number"
            ? entry.data
            : ""
      }));
    }

    function characterIdFromProfile(profile) {
      const sharable = asObject(profile.sharableCharacter);
      const direct = sharable.id ?? sharable.characterId ?? profile.characterId ?? profile.characterID;
      if (Number.isFinite(Number(direct))) return Number(direct);
      const skills = Array.isArray(profile.characterSkills)
        ? profile.characterSkills
        : Object.values(asObject(profile.characterSkills));
      const skillId = skills[0]?.characterID ?? skills[0]?.characterId;
      return Number.isFinite(Number(skillId)) ? Number(skillId) : null;
    }

    function profileActivityState(sharable) {
      const actionType = typeof sharable.actionType === "string" ? sharable.actionType.trim() : "";
      if (actionType) return "work";
      if (sharable.hideOnlineStatus === true) return "none";
      if (sharable.isOnline === false) return "offline";
      return "none";
    }

    function numberOrNull(value) {
      return Number.isFinite(Number(value)) ? Number(value) : null;
    }

    function listFrom(value) {
      if (Array.isArray(value)) return value;
      const object = asObject(value);
      return Object.entries(object).map(([mapKey, entry]) => ({ mapKey, ...asObject(entry) }));
    }

    function firstString(entry, keys, fallback = "") {
      for (const key of keys) {
        if (typeof entry?.[key] === "string" && entry[key]) return entry[key];
      }
      return fallback;
    }

    function sanitizeSkills(value) {
      if (value == null) return null;
      return listFrom(value).map((entry) => ({
        skillHrid: firstString(entry, ["skillHrid", "skillHRID", "hrid"], entry.mapKey || ""),
        level: numberOrNull(entry.level),
        experience: numberOrNull(entry.experience)
      })).filter((entry) => entry.skillHrid);
    }

    function sanitizeAchievements(value) {
      if (value == null) return null;
      return listFrom(value).map((entry) => ({
        achievementHrid: firstString(entry, ["achievementHrid", "achievementHRID", "hrid"], entry.mapKey || ""),
        progress: numberOrNull(entry.progress ?? entry.currentValue ?? entry.value),
        completed: entry.completed === true || entry.isCompleted === true || entry.completedAt != null
          ? true
          : entry.completed === false || entry.isCompleted === false
            ? false
            : null
      })).filter((entry) => entry.achievementHrid);
    }

    function sanitizeEquipment(value) {
      if (value == null) return null;
      return listFrom(value).map((entry) => ({
        slotHrid: firstString(entry, ["slotHrid", "slotHRID", "slot"], entry.mapKey || ""),
        itemHrid: firstString(entry, ["itemHrid", "itemHRID", "hrid"]),
        enhancementLevel: numberOrNull(entry.enhancementLevel ?? entry.level)
      })).filter((entry) => entry.slotHrid || entry.itemHrid);
    }

    function sanitizeAbilities(value) {
      if (value == null) return null;
      return listFrom(value).map((entry) => ({
        slotNumber: numberOrNull(entry.slotNumber ?? entry.mapKey),
        abilityHrid: firstString(entry, ["abilityHrid", "abilityHRID", "hrid"]),
        level: numberOrNull(entry.level),
        experience: numberOrNull(entry.experience)
      })).filter((entry) => entry.abilityHrid || entry.slotNumber !== null);
    }

    function sanitizeHouseRooms(value) {
      if (value == null) return null;
      return listFrom(value).map((entry) => ({
        roomHrid: firstString(entry, ["roomHrid", "roomHRID", "hrid"], entry.mapKey || ""),
        level: numberOrNull(entry.level)
      })).filter((entry) => entry.roomHrid);
    }

    function profileSnapshots(profile, sharable) {
      const skills = sanitizeSkills(profile.characterSkills);
      const totalSkill = skills?.find((entry) => /(?:^|\/)total_level$/i.test(entry.skillHrid)) || null;
      const achievements = sanitizeAchievements(profile.characterAchievements);
      const completedAchievements = achievements?.some((entry) => entry.completed !== null)
        ? achievements.filter((entry) => entry.completed).length
        : numberOrNull(profile.achievementsCompleted ?? profile.completedAchievementCount);
      const actionType = typeof sharable.actionType === "string" && sharable.actionType.trim()
        ? sharable.actionType.trim()
        : null;
      let presenceState = "unknown";
      if (sharable.isOnline === true) presenceState = "online";
      else if (sharable.hideOnlineStatus === true) presenceState = "hidden";
      else if (sharable.isOnline === false) presenceState = "offline";
      return {
        presenceSnapshot: { state: presenceState, actionType },
        progressSnapshot: {
          metrics: {
            totalLevel: numberOrNull(totalSkill?.level ?? profile.totalLevel),
            totalExperience: numberOrNull(totalSkill?.experience ?? profile.totalExperience),
            combatLevel: numberOrNull(profile.combatLevel),
            achievementsCompleted: completedAchievements,
            achievementsObservedTotal: achievements ? achievements.length : null,
            totalTaskPoints: numberOrNull(profile.totalTaskPoints),
            labyrinthPoints: numberOrNull(profile.labyrinthPoints),
            labyrinthHighestFloor: numberOrNull(profile.labyrinthHighestFloor),
            labyrinthHighestFloorRooms: numberOrNull(profile.labyrinthHighestFloorRooms),
            collectionPoints: numberOrNull(profile.collectionPoints),
            bestiaryPoints: numberOrNull(profile.bestiaryPoints),
            famePoints: numberOrNull(profile.famePoints)
          },
          skills,
          achievements,
          equipment: sanitizeEquipment(profile.wearableItemMap),
          equippedAbilities: sanitizeAbilities(profile.equippedAbilities),
          houseRooms: sanitizeHouseRooms(profile.characterHouseRoomMap)
        }
      };
    }

    function sanitizeLeaderboardRows(rows) {
      if (!Array.isArray(rows)) return [];
      return rows.map((row) => ({
        rank: Number.isFinite(Number(row?.rank)) ? Number(row.rank) : null,
        name: typeof row?.name === "string" ? row.name : "",
        characterId: numberOrNull(row?.characterId ?? row?.characterID),
        value1: row?.value1 ?? null,
        value2: row?.value2 ?? null
      }));
    }

    function sanitizeGuildCharacters(message) {
      const characterMap = asObject(message.guildCharacterMap);
      const sharableMap = asObject(message.guildSharableCharacterMap);
      const result = [];
      for (const [id, guildCharacter] of Object.entries(characterMap)) {
        const sharable = asObject(sharableMap[id]);
        result.push({
          characterId: Number.isFinite(Number(id)) ? Number(id) : null,
          name: typeof sharable.name === "string" ? sharable.name : "",
          status: typeof guildCharacter?.status === "string" ? guildCharacter.status : "",
          role: typeof guildCharacter?.role === "string" ? guildCharacter.role : "",
          joinTime: guildCharacter?.joinTime || null
        });
      }
      return result;
    }

    function sanitize(message) {
      const type = typeof message?.type === "string" ? message.type : "";
      if (!observed.has(type)) return null;
      if (type === "get_leaderboard") {
        const data = asObject(message.getLeaderboardData);
        return {
          type,
          leaderboardType: data.leaderboardType || null,
          leaderboardCategory: data.leaderboardCategory || null,
          guildTypeFilter: data.guildTypeFilter || "all",
          gameModeFilter: data.gameModeFilter || "all",
          trialFilter: data.trialFilter || "all"
        };
      }
      if (type === "leaderboard_updated") {
        const leaderboard = asObject(message.leaderboard);
        const responseFiltersKnown = ["guildTypeFilter", "gameModeFilter", "trialFilter"]
          .some((key) => message[key] != null || leaderboard[key] != null);
        return {
          type,
          leaderboardType: leaderboard.type || message.leaderboardType || null,
          leaderboardCategory: leaderboard.category || message.leaderboardCategory || null,
          guildTypeFilter: message.guildTypeFilter || leaderboard.guildTypeFilter || "all",
          gameModeFilter: message.gameModeFilter || leaderboard.gameModeFilter || "all",
          trialFilter: message.trialFilter || leaderboard.trialFilter || "all",
          filtersKnown: responseFiltersKnown,
          leaderboardRevision: Number(message.leaderboardRevision || 0),
          columnNames: Array.isArray(leaderboard.columnNames || message.columnNames)
            ? (leaderboard.columnNames || message.columnNames).slice(0, 4).map((value) => String(value || ""))
            : [],
          rows: sanitizeLeaderboardRows(leaderboard.rows || message.rows)
        };
      }
      if (type === "view_profile") {
        return {
          type,
          characterName: message.viewProfileData?.characterName || message.characterName || ""
        };
      }
      if (type === "profile_shared") {
        const profile = asObject(message.profile || message.profileSharedData || message.profileData);
        const sharable = asObject(profile.sharableCharacter);
        const snapshots = profileSnapshots(profile, sharable);
        return {
          type,
          profile: {
            name: sharable.name || profile.characterName || profile.name || "",
            characterId: characterIdFromProfile(profile),
            guildId: profile.guildId ?? null,
            guildName: profile.guildName ?? null,
            guildRole: profile.guildRole ?? null,
            activityState: profileActivityState(sharable),
            presenceSnapshot: snapshots.presenceSnapshot,
            progressSnapshot: snapshots.progressSnapshot
          }
        };
      }
      if (type === "send_guild_invite") {
        return {
          type,
          characterName: message.sendGuildInviteData?.characterName || message.characterName || ""
        };
      }
      if (type === "info" || type === "error") {
        return {
          type,
          messageKey: message.message || message.messageKey || "",
          variables: cleanVariables(message.variables || message.messageVariables)
        };
      }
      if (type === "guild_characters_updated") {
        return {
          type,
          guildId: message.guildId ?? message.guild?.id ?? null,
          guildName: message.guildName ?? message.guild?.name ?? null,
          characters: sanitizeGuildCharacters(message)
        };
      }
      if (type === "init_character_data") {
        const characterData = asObject(message.characterData);
        const character = asObject(characterData.character || message.character);
        const guild = asObject(characterData.guild || message.guild);
        return {
          type,
          character: {
            id: character.id ?? character.characterId ?? characterData.characterId ?? null,
            name: character.name ?? characterData.characterName ?? "",
            guildId: guild.id ?? characterData.guildId ?? null,
            guildName: guild.name ?? characterData.guildName ?? null
          },
          characters: sanitizeGuildCharacters(characterData)
        };
      }
      return { type };
    }

    function publish(direction, raw, capturedAt) {
      if (typeof raw !== "string") return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_error) {
        return;
      }
      const message = sanitize(parsed);
      if (!message) return;
      const at = typeof capturedAt === "string" && Number.isFinite(Date.parse(capturedAt))
        ? capturedAt
        : new Date().toISOString();
      const envelope = JSON.stringify({ direction, at, message });
      window.dispatchEvent(new CustomEvent(options.eventName, { detail: envelope }));
    }

    function observe(socket, url) {
      if (!isOfficial(url) || socket.__mwiGitObserved) return socket;
      Object.defineProperty(socket, "__mwiGitObserved", { value: true });
      const originalSend = socket.send;
      socket.send = function trackedSend(data) {
        publish("out", data);
        return originalSend.apply(this, arguments);
      };
      socket.addEventListener("message", (event) => publish("in", event.data));
      return socket;
    }

    function WrappedWebSocket(url, protocols) {
      const socket = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      return observe(socket, url);
    }

    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(WrappedWebSocket, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = WrappedWebSocket;

    // The development loader starts before the asynchronous runtime. Adopt
    // sockets and replay relevant frames captured during that small gap.
    const developmentBridge = window.__mwiGitDevBridgeV1;
    if (developmentBridge && typeof developmentBridge === "object") {
      const sockets = Array.isArray(developmentBridge.sockets) ? [...developmentBridge.sockets] : [];
      const frames = Array.isArray(developmentBridge.frames) ? [...developmentBridge.frames] : [];
      developmentBridge.active = false;
      for (const socket of sockets) observe(socket, socket?.url);
      for (const frame of frames) publish(frame?.direction, frame?.data, frame?.at);
      developmentBridge.frames.length = 0;
      developmentBridge.sockets.length = 0;
    }
  }

  function source() {
    return `;(${pageBridgeInstaller.toString()})(${JSON.stringify({
      marker: app.config.bridgeMarker,
      eventName: app.config.bridgeEvent,
      observedTypes: app.config.observedTypes
    })});`;
  }

  function inject() {
    const code = source();
    if (typeof root.GM_addElement === "function") {
      root.GM_addElement("script", { textContent: code });
      return true;
    }
    const script = root.document.createElement("script");
    script.textContent = code;
    (root.document.documentElement || root.document.head).append(script);
    script.remove();
    return true;
  }

  app.bridge = Object.freeze({ pageBridgeInstaller, source, inject });
})(globalThis);

// ---- src/runtime/game-protocol.js ----
(function initGameProtocol(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function parseEnvelope(detail) {
    let envelope = detail;
    if (typeof detail === "string") {
      try {
        envelope = JSON.parse(detail);
      } catch (_error) {
        return null;
      }
    }
    if (!envelope || (envelope.direction !== "in" && envelope.direction !== "out")) return null;
    if (!core.isIsoDate(envelope.at) || !envelope.message || typeof envelope.message.type !== "string") return null;
    return envelope;
  }

  function variableName(variables) {
    if (!Array.isArray(variables)) return "";
    const preferred = variables.find((entry) => /^(name|characterName|playerName)$/i.test(entry?.name));
    const fallback = variables.find((entry) => typeof entry?.data === "string");
    return String((preferred || fallback)?.data || "").trim();
  }

  function toDomainEvent(detail) {
    const envelope = parseEnvelope(detail);
    if (!envelope) return null;
    const { direction, at, message } = envelope;
    const type = message.type;

    if (direction === "out" && type === "get_leaderboard") {
      return {
        kind: "leaderboard_requested",
        at,
        leaderboard: {
          typeHrid: message.leaderboardType,
          categoryHrid: message.leaderboardCategory,
          filters: {
            guildType: message.guildTypeFilter || "all",
            gameMode: message.gameModeFilter || "all",
            trial: message.trialFilter || "all"
          }
        }
      };
    }
    if (direction === "in" && type === "leaderboard_updated") {
      return {
        kind: "leaderboard_snapshot",
        at,
        leaderboard: {
          typeHrid: message.leaderboardType,
          categoryHrid: message.leaderboardCategory,
          filters: {
            guildType: message.guildTypeFilter || "all",
            gameMode: message.gameModeFilter || "all",
            trial: message.trialFilter || "all"
          },
          filtersKnown: message.filtersKnown !== false,
          revision: Number(message.leaderboardRevision || 0),
          capturedAt: at,
          columnNames: Array.isArray(message.columnNames) ? message.columnNames.slice(0, 4) : [],
          rows: Array.isArray(message.rows)
            ? message.rows.filter((row) => row && typeof row.name === "string" && row.name.trim())
            : []
        }
      };
    }
    if (direction === "out" && type === "view_profile") {
      const name = String(message.characterName || "").trim();
      return name ? { kind: "profile_requested", at, name } : null;
    }
    if (direction === "in" && type === "profile_shared") {
      const profile = message.profile || {};
      const name = String(profile.name || "").trim();
      return name ? { kind: "profile_received", at, profile: { ...profile, name } } : null;
    }
    if (direction === "out" && type === "send_guild_invite") {
      const name = String(message.characterName || "").trim();
      return name ? { kind: "invite_attempted", at, name } : null;
    }
    if (direction === "in" && type === "info" && message.messageKey === "infoNotification.guildInviteSent") {
      return { kind: "invite_succeeded", at, name: variableName(message.variables), correlation: "info" };
    }
    if (direction === "in" && type === "error") {
      return {
        kind: "invite_failed",
        at,
        name: variableName(message.variables),
        errorKey: message.messageKey || "",
        outcome: core.outcomeFromErrorKey(message.messageKey)
      };
    }
    if (direction === "in" && type === "guild_characters_updated") {
      return {
        kind: "guild_characters",
        at,
        guildId: core.nullableNumber(message.guildId),
        guildName: typeof message.guildName === "string" ? message.guildName : null,
        characters: Array.isArray(message.characters) ? message.characters : []
      };
    }
    if (direction === "in" && type === "init_character_data") {
      const character = message.character || {};
      const id = core.nullableNumber(character.id);
      const name = String(character.name || "").trim();
      if (id === null || !name) return null;
      return {
        kind: "identity",
        at,
        identity: {
          hostname: root.location?.hostname || "unknown",
          characterId: id,
          characterName: name,
          guildId: core.nullableNumber(character.guildId),
          guildName: typeof character.guildName === "string" ? character.guildName : null
        },
        guildCharacters: Array.isArray(message.characters) ? message.characters : []
      };
    }
    return null;
  }

  app.gameProtocol = Object.freeze({ parseEnvelope, variableName, toDomainEvent });
})(globalThis);

// ---- src/runtime/context-tracker.js ----
(function initContextTracker(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function createContextTracker(options = {}) {
    const config = app.config;
    const randomUUID = options.randomUUID;
    let identity = options.identity || null;
    let leaderboard = null;
    const pendingLeaderboards = [];
    const pendingProfiles = [];
    const pendingInvites = [];
    const recentProfiles = new Map();

    function prune(now) {
      const resolvedCutoff = now - Math.max(config.profileTimeoutMs, config.inviteTimeoutMs, config.leaderboardTimeoutMs) * 4;
      for (let index = pendingLeaderboards.length - 1; index >= 0; index -= 1) {
        if (Date.parse(pendingLeaderboards[index].requestedAt) < resolvedCutoff) pendingLeaderboards.splice(index, 1);
      }
      for (let index = pendingProfiles.length - 1; index >= 0; index -= 1) {
        if (pendingProfiles[index].resolved && Date.parse(pendingProfiles[index].requestedAt) < resolvedCutoff) {
          pendingProfiles.splice(index, 1);
        }
      }
      for (let index = pendingInvites.length - 1; index >= 0; index -= 1) {
        if (pendingInvites[index].resolved && Date.parse(pendingInvites[index].requestedAt) < resolvedCutoff) {
          pendingInvites.splice(index, 1);
        }
      }
      for (const [key, timestamp] of recentProfiles) {
        if (timestamp < now - config.duplicateWindowMs * 4) recentProfiles.delete(key);
      }
    }

    function findRow(name) {
      if (!leaderboard) return null;
      const normalized = core.normalizeName(name);
      return leaderboard.rows.find((row) => core.normalizeName(row.name) === normalized) || null;
    }

    function leaderboardContext(name) {
      const row = findRow(name);
      if (!leaderboard || !row) return { source: "unknown", leaderboard: null };
      return {
        source: "leaderboard",
        leaderboard: {
          typeHrid: leaderboard.typeHrid,
          categoryHrid: leaderboard.categoryHrid,
          filters: core.structuredCloneSafe(leaderboard.filters),
          rank: row.rank,
          value1: row.value1 ?? null,
          value2: row.value2 ?? null,
          revision: leaderboard.revision,
          capturedAt: leaderboard.capturedAt
        }
      };
    }

    function pendingByName(list, name) {
      const normalized = core.normalizeName(name);
      return list.filter((entry) => entry.normalizedName === normalized && !entry.resolved);
    }

    function resolveInvite(entry, event, outcome, correlation, errorKey) {
      entry.resolved = true;
      entry.record = core.applyInviteOutcome(entry.record, outcome, event.at, correlation, errorKey);
      return { type: "update_invite", invite: entry.record };
    }

    function filterKey(filters) {
      return [filters?.guildType || "all", filters?.gameMode || "all", filters?.trial || "all"].join("|");
    }

    function matchesLeaderboard(request, snapshot) {
      if (request.resolved) return false;
      const same = (left, right) => !left || !right || left === right;
      return same(request.leaderboard.typeHrid, snapshot.typeHrid) &&
        same(request.leaderboard.categoryHrid, snapshot.categoryHrid) &&
        (snapshot.filtersKnown === false || filterKey(request.leaderboard.filters) === filterKey(snapshot.filters));
    }

    function isPlayerLeaderboard(value) {
      return !/(^|[\/_])guild(?:$|[\/_])/i.test(String(value?.typeHrid || ""));
    }

    function makeLeaderboardRecord(request, snapshot) {
      const captureId = core.uuid(randomUUID);
      const resolvedFilters = snapshot.filtersKnown === false ? request.leaderboard.filters : snapshot.filters;
      const key = filterKey(resolvedFilters);
      const capture = {
        id: captureId,
        typeHrid: snapshot.typeHrid || request.leaderboard.typeHrid || null,
        categoryHrid: snapshot.categoryHrid || request.leaderboard.categoryHrid || null,
        filters: core.structuredCloneSafe(resolvedFilters),
        filterKey: key,
        columnNames: Array.isArray(snapshot.columnNames) ? [...snapshot.columnNames] : [],
        requestedAt: request.requestedAt,
        capturedAt: snapshot.capturedAt,
        revision: snapshot.revision,
        rowCount: snapshot.rows.length
      };
      const entries = snapshot.rows.map((row, index) => {
        const player = core.playerFromLeaderboard(row, snapshot.capturedAt);
        const value1 = core.nullableNumber(row.value1);
        const value2 = core.nullableNumber(row.value2);
        return {
          id: `${captureId}:${index + 1}`,
          captureId,
          playerKey: player.playerKey,
          characterId: player.characterId,
          normalizedName: player.normalizedName,
          name: player.currentName,
          typeHrid: capture.typeHrid,
          categoryHrid: capture.categoryHrid,
          filters: core.structuredCloneSafe(capture.filters),
          filterKey: key,
          columnNames: [...capture.columnNames],
          rank: core.nullableNumber(row.rank),
          value1,
          value2,
          experienceValue: value2 ?? value1,
          capturedAt: snapshot.capturedAt
        };
      }).filter((entry) => entry.normalizedName);
      return {
        type: "record_leaderboard",
        capture,
        entries,
        players: entries.map((entry) => core.playerFromLeaderboard(entry, snapshot.capturedAt))
      };
    }

    function consume(event) {
      if (!event) return [];
      prune(Date.parse(event.at || 0) || Date.now());
      if (event.kind === "identity") {
        identity = event.identity;
        const actions = [{ type: "identity", identity }];
        const joined = (event.guildCharacters || []).filter(
          (character) => character?.status === "joined" && character.name
        );
        if (joined.length) {
          actions.push({
            type: "sync_guild_members",
            characters: joined,
            observedAt: event.at,
            identity
          });
        }
        return actions;
      }
      if (event.kind === "leaderboard_snapshot") {
        leaderboard = event.leaderboard;
        const actions = [{ type: "leaderboard", leaderboard }];
        const request = [...pendingLeaderboards].reverse().find((entry) => matchesLeaderboard(entry, leaderboard));
        if (request) {
          request.resolved = true;
          if (isPlayerLeaderboard(leaderboard)) actions.push(makeLeaderboardRecord(request, leaderboard));
        }
        return actions;
      }
      if (event.kind === "leaderboard_requested") {
        pendingLeaderboards.push({
          id: core.uuid(randomUUID),
          requestedAt: event.at,
          leaderboard: core.structuredCloneSafe(event.leaderboard),
          resolved: false
        });
        return [];
      }
      if (event.kind === "profile_requested") {
        pendingProfiles.push({
          name: event.name,
          normalizedName: core.normalizeName(event.name),
          requestedAt: event.at,
          context: leaderboardContext(event.name),
          resolved: false
        });
        return [];
      }
      if (event.kind === "profile_received") {
        const normalized = core.normalizeName(event.profile.name);
        const duplicateKey = `${normalized}|${JSON.stringify(event.profile)}|${leaderboard?.revision || 0}`;
        const last = recentProfiles.get(duplicateKey);
        const time = Date.parse(event.at);
        if (last && time - last < config.duplicateWindowMs) return [];
        recentProfiles.set(duplicateKey, time);
        const candidates = pendingByName(pendingProfiles, event.profile.name);
        const pending = candidates[candidates.length - 1];
        if (pending) pending.resolved = true;
        const context = pending ? pending.context : { source: "unknown", leaderboard: null };
        const observation = core.makeObservation(event.profile, context, event.at, randomUUID);
        return [{ type: "record_observation", player: core.playerFromProfile(event.profile, event.at), observation }];
      }
      if (event.kind === "invite_attempted") {
        const player = core.playerFromInvite(event.name, event.at);
        const record = core.makeInviteEvent(event.name, event.at, identity, null, randomUUID);
        pendingInvites.push({
          normalizedName: record.normalizedName,
          requestedAt: event.at,
          resolved: false,
          record
        });
        return [{ type: "record_invite", player, invite: record }];
      }
      if (event.kind === "invite_succeeded" || event.kind === "invite_failed") {
        const candidates = event.name
          ? pendingByName(pendingInvites, event.name)
          : pendingInvites.filter((entry) => !entry.resolved);
        if (candidates.length === 1) {
          const outcome = event.kind === "invite_succeeded" ? "sent" : event.outcome;
          const correlation = event.kind === "invite_succeeded" ? event.correlation : "error";
          return [resolveInvite(candidates[0], event, outcome, correlation, event.errorKey)];
        }
        if (candidates.length > 1) {
          return candidates.map((entry) => resolveInvite(entry, event, "ambiguous", "ambiguous", event.errorKey));
        }
        return [];
      }
      if (event.kind === "guild_characters") {
        const actions = [];
        if (identity) {
          identity = { ...identity, guildId: event.guildId ?? identity.guildId, guildName: event.guildName ?? identity.guildName };
          actions.push({ type: "identity", identity });
        }
        const joined = event.characters.filter(
          (character) => character?.status === "joined" && character.name
        );
        if (joined.length) {
          actions.push({
            type: "sync_guild_members",
            characters: joined,
            observedAt: event.at,
            identity
          });
        }
        for (const character of event.characters) {
          if (character.status !== "invited" || !character.name) continue;
          const candidates = pendingByName(pendingInvites, character.name);
          if (candidates.length === 1) {
            actions.push(resolveInvite(candidates[0], event, "sent", "guild_characters_updated", null));
          } else if (candidates.length === 0) {
            actions.push({
              type: "detected_invite",
              character,
              detectedAt: event.at,
              identity
            });
          }
        }
        return actions;
      }
      return [];
    }

    function expire(now = Date.now()) {
      prune(now);
      const actions = [];
      for (const entry of pendingProfiles) {
        if (!entry.resolved && now - Date.parse(entry.requestedAt) >= config.profileTimeoutMs) {
          entry.resolved = true;
          actions.push({ type: "profile_timeout", name: entry.name, requestedAt: entry.requestedAt });
        }
      }
      for (const entry of pendingInvites) {
        if (!entry.resolved && now - Date.parse(entry.requestedAt) >= config.inviteTimeoutMs) {
          actions.push(resolveInvite(entry, { at: new Date(now).toISOString() }, "timeout", "timeout", null));
        }
      }
      return actions;
    }

    function state() {
      return {
        identity: core.structuredCloneSafe(identity),
        leaderboard: core.structuredCloneSafe(leaderboard),
        pendingProfiles: pendingProfiles.filter((entry) => !entry.resolved).length,
        pendingLeaderboards: pendingLeaderboards.filter((entry) => !entry.resolved).length,
        pendingInvites: pendingInvites.filter((entry) => !entry.resolved).length
      };
    }

    return { consume, expire, state };
  }

  app.contextTracker = Object.freeze({ createContextTracker });
})(globalThis);

// ---- src/runtime/storage.js ----
(function initStorage(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const STORE_NAMES = ["players", "profileObservations", "inviteEvents", "leaderboardCaptures", "leaderboardEntries", "metadata"];

  function namespaceFor(identity) {
    if (!identity || identity.characterId == null) return null;
    return `${String(identity.hostname || "unknown").toLowerCase()}|character:${Number(identity.characterId)}`;
  }

  function dbRecord(namespace, kind, record) {
    const id = kind === "players" ? record.playerKey : record.id;
    return { ...core.structuredCloneSafe(record), pk: `${namespace}::${id}`, namespace };
  }

  function publicRecord(record) {
    if (!record) return record;
    const clone = { ...record };
    delete clone.pk;
    delete clone.namespace;
    return clone;
  }

  function isEligibleLeaderboardEntry(player, entry) {
    const guildObservedAt = Date.parse(player?.latestGuild?.observedAt || 0);
    const capturedAt = Date.parse(entry?.capturedAt || 0);
    return player?.latestGuild?.state === "none" &&
      guildObservedAt > 0 && capturedAt > 0 && guildObservedAt <= capturedAt &&
      core.nullableNumber(entry?.experienceValue) !== null;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  }

  function openDatabase(indexedDBImpl = root.indexedDB) {
    if (!indexedDBImpl) return Promise.reject(new Error("IndexedDB is unavailable"));
    return new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(app.config.databaseName, app.config.databaseVersion);
      request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("players")) {
          const players = db.createObjectStore("players", { keyPath: "pk" });
          players.createIndex("namespace", "namespace", { unique: false });
          players.createIndex("namespace_character", ["namespace", "characterId"], { unique: false });
          players.createIndex("namespace_name", ["namespace", "normalizedName"], { unique: false });
          players.createIndex("namespace_last_viewed", ["namespace", "lastViewedAt"], { unique: false });
        }
        if (!db.objectStoreNames.contains("profileObservations")) {
          const observations = db.createObjectStore("profileObservations", { keyPath: "pk" });
          observations.createIndex("namespace", "namespace", { unique: false });
          observations.createIndex("namespace_player", ["namespace", "playerKey"], { unique: false });
          observations.createIndex("namespace_viewed", ["namespace", "viewedAt"], { unique: false });
        }
        if (!db.objectStoreNames.contains("inviteEvents")) {
          const invites = db.createObjectStore("inviteEvents", { keyPath: "pk" });
          invites.createIndex("namespace", "namespace", { unique: false });
          invites.createIndex("namespace_player", ["namespace", "playerKey"], { unique: false });
          invites.createIndex("namespace_attempted", ["namespace", "attemptedAt"], { unique: false });
          invites.createIndex("namespace_outcome", ["namespace", "outcome"], { unique: false });
        }
        if (!db.objectStoreNames.contains("leaderboardCaptures")) {
          const captures = db.createObjectStore("leaderboardCaptures", { keyPath: "pk" });
          captures.createIndex("namespace", "namespace", { unique: false });
          captures.createIndex("namespace_captured", ["namespace", "capturedAt"], { unique: false });
          captures.createIndex("namespace_category", ["namespace", "categoryHrid"], { unique: false });
        }
        if (!db.objectStoreNames.contains("leaderboardEntries")) {
          const entries = db.createObjectStore("leaderboardEntries", { keyPath: "pk" });
          entries.createIndex("namespace", "namespace", { unique: false });
          entries.createIndex("namespace_player", ["namespace", "playerKey"], { unique: false });
          entries.createIndex("namespace_capture", ["namespace", "captureId"], { unique: false });
          entries.createIndex("namespace_captured", ["namespace", "capturedAt"], { unique: false });
        }
        if (!db.objectStoreNames.contains("metadata")) {
          const metadata = db.createObjectStore("metadata", { keyPath: "pk" });
          metadata.createIndex("namespace", "namespace", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function createRepository(options = {}) {
    let databasePromise = null;
    const indexedDBImpl = options.indexedDB || root.indexedDB;

    function database() {
      databasePromise = databasePromise || openDatabase(indexedDBImpl);
      return databasePromise;
    }

    async function getByIndex(store, index, key) {
      return requestPromise(store.index(index).get(key));
    }

    async function rewritePlayerKey(transaction, namespace, oldKey, newKey) {
      if (!oldKey || oldKey === newKey) return;
      for (const storeName of ["profileObservations", "inviteEvents", "leaderboardEntries"]) {
        const store = transaction.objectStore(storeName);
        const records = await requestPromise(store.index("namespace_player").getAll([namespace, oldKey]));
        for (const record of records) {
          record.playerKey = newKey;
          store.put(record);
        }
      }
    }

    async function findPlayer(transaction, namespace, player) {
      const store = transaction.objectStore("players");
      if (player.characterId != null) {
        const byId = await getByIndex(store, "namespace_character", [namespace, Number(player.characterId)]);
        if (byId) return byId;
      }
      if (player.normalizedName) {
        return getByIndex(store, "namespace_name", [namespace, player.normalizedName]);
      }
      return null;
    }

    async function recordObservation(namespace, player, observation) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents", "leaderboardEntries"], "readwrite");
      const done = transactionPromise(tx);
      try {
        const existing = await findPlayer(tx, namespace, player);
        const merged = core.mergePlayer(existing && publicRecord(existing), player);
        if (existing && existing.playerKey !== merged.playerKey) {
          await rewritePlayerKey(tx, namespace, existing.playerKey, merged.playerKey);
          tx.objectStore("players").delete(existing.pk);
        }
        observation.playerKey = merged.playerKey;
        tx.objectStore("players").put(dbRecord(namespace, "players", merged));
        tx.objectStore("profileObservations").put(dbRecord(namespace, "profileObservations", observation));
        await done;
        return { player: merged, observation };
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function recordLeaderboard(namespace, players, capture, entries) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents", "leaderboardCaptures", "leaderboardEntries"], "readwrite");
      const done = transactionPromise(tx);
      const mergedPlayers = [];
      const eligibleEntries = [];
      try {
        for (let index = 0; index < (players || []).length; index += 1) {
          const player = players[index];
          if (!player?.normalizedName) continue;
          const existing = await findPlayer(tx, namespace, player);
          const merged = core.mergePlayer(existing && publicRecord(existing), player);
          if (existing && existing.playerKey !== merged.playerKey) {
            await rewritePlayerKey(tx, namespace, existing.playerKey, merged.playerKey);
            tx.objectStore("players").delete(existing.pk);
          }
          if (entries[index]) {
            entries[index].playerKey = merged.playerKey;
            if (isEligibleLeaderboardEntry(merged, entries[index])) {
              eligibleEntries.push({
                ...entries[index],
                noGuildConfirmedAtCapture: true
              });
            }
          }
          tx.objectStore("players").put(dbRecord(namespace, "players", merged));
          mergedPlayers.push(merged);
        }
        const storedCapture = { ...capture, eligibleRowCount: eligibleEntries.length };
        tx.objectStore("leaderboardCaptures").put(dbRecord(namespace, "leaderboardCaptures", storedCapture));
        for (const entry of eligibleEntries) {
          tx.objectStore("leaderboardEntries").put(dbRecord(namespace, "leaderboardEntries", entry));
        }
        await done;
        return { players: mergedPlayers, capture: storedCapture, entries: eligibleEntries };
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function recordInvite(namespace, player, invite) {
      const db = await database();
      const tx = db.transaction(["players", "inviteEvents"], "readwrite");
      const done = transactionPromise(tx);
      try {
        const existing = await findPlayer(tx, namespace, player);
        const merged = core.mergePlayer(existing && publicRecord(existing), player);
        invite.playerKey = merged.playerKey;
        merged.lastInvitedAt = core.laterIso
          ? core.laterIso(merged.lastInvitedAt, invite.attemptedAt)
          : invite.attemptedAt;
        tx.objectStore("players").put(dbRecord(namespace, "players", merged));
        tx.objectStore("inviteEvents").put(dbRecord(namespace, "inviteEvents", invite));
        await done;
        return { player: merged, invite };
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function upsertPlayers(namespace, players) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents", "leaderboardEntries"], "readwrite");
      const done = transactionPromise(tx);
      const mergedPlayers = [];
      try {
        for (const player of players || []) {
          if (!player?.normalizedName) continue;
          const existing = await findPlayer(tx, namespace, player);
          const merged = core.mergePlayer(existing && publicRecord(existing), player);
          if (existing && existing.playerKey !== merged.playerKey) {
            await rewritePlayerKey(tx, namespace, existing.playerKey, merged.playerKey);
            tx.objectStore("players").delete(existing.pk);
          }
          tx.objectStore("players").put(dbRecord(namespace, "players", merged));
          mergedPlayers.push(merged);
        }
        await done;
        return mergedPlayers;
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function updateInvite(namespace, invite) {
      const db = await database();
      const tx = db.transaction("inviteEvents", "readwrite");
      const done = transactionPromise(tx);
      const store = tx.objectStore("inviteEvents");
      const existing = await requestPromise(store.get(`${namespace}::${invite.id}`));
      const next = {
        ...invite,
        playerKey: existing?.playerKey || invite.playerKey
      };
      store.put(dbRecord(namespace, "inviteEvents", next));
      await done;
      return next;
    }

    async function snapshot(namespace) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents", "leaderboardCaptures", "leaderboardEntries"], "readonly");
      const data = {};
      for (const name of ["players", "profileObservations", "inviteEvents", "leaderboardCaptures", "leaderboardEntries"]) {
        const records = await requestPromise(tx.objectStore(name).index("namespace").getAll(namespace));
        data[name] = records.map(publicRecord);
      }
      await transactionPromise(tx);
      return data;
    }

    async function clearStoreNamespace(store, namespace) {
      const keys = await requestPromise(store.index("namespace").getAllKeys(namespace));
      for (const key of keys) store.delete(key);
    }

    async function replaceSnapshot(namespace, data) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents", "leaderboardCaptures", "leaderboardEntries"], "readwrite");
      const done = transactionPromise(tx);
      try {
        for (const name of ["players", "profileObservations", "inviteEvents", "leaderboardCaptures", "leaderboardEntries"]) {
          await clearStoreNamespace(tx.objectStore(name), namespace);
          for (const record of data[name] || []) {
            tx.objectStore(name).put(dbRecord(namespace, name, record));
          }
        }
        await done;
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function deletePlayer(namespace, key) {
      const current = await snapshot(namespace);
      const next = {
        players: current.players.filter((player) => player.playerKey !== key),
        profileObservations: current.profileObservations.filter((event) => event.playerKey !== key),
        inviteEvents: current.inviteEvents.filter((event) => event.playerKey !== key),
        leaderboardCaptures: current.leaderboardCaptures,
        leaderboardEntries: current.leaderboardEntries.filter((entry) => entry.playerKey !== key)
      };
      await replaceSnapshot(namespace, next);
    }

    async function clearNamespace(namespace) {
      return replaceSnapshot(namespace, { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] });
    }

    async function close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = null;
    }

    return {
      namespaceFor,
      recordObservation,
      recordLeaderboard,
      recordInvite,
      upsertPlayers,
      updateInvite,
      snapshot,
      replaceSnapshot,
      deletePlayer,
      clearNamespace,
      close
    };
  }

  function createMemoryRepository() {
    const spaces = new Map();
    function get(namespace) {
      if (!spaces.has(namespace)) {
        spaces.set(namespace, { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] });
      }
      return spaces.get(namespace);
    }
    async function snapshot(namespace) {
      return core.structuredCloneSafe(get(namespace));
    }
    async function replaceSnapshot(namespace, data) {
      spaces.set(namespace, core.structuredCloneSafe({
        players: data.players || [],
        profileObservations: data.profileObservations || [],
        inviteEvents: data.inviteEvents || [],
        leaderboardCaptures: data.leaderboardCaptures || [],
        leaderboardEntries: data.leaderboardEntries || []
      }));
    }
    async function recordObservation(namespace, player, observation) {
      const data = get(namespace);
      const index = data.players.findIndex(
        (item) =>
          (player.characterId != null && item.characterId === player.characterId) ||
          item.normalizedName === player.normalizedName
      );
      const existing = index >= 0 ? data.players[index] : null;
      const merged = core.mergePlayer(existing, player);
      if (existing && existing.playerKey !== merged.playerKey) {
        for (const event of [...data.profileObservations, ...data.inviteEvents, ...data.leaderboardEntries]) {
          if (event.playerKey === existing.playerKey) event.playerKey = merged.playerKey;
        }
      }
      if (index >= 0) data.players[index] = merged;
      else data.players.push(merged);
      observation.playerKey = merged.playerKey;
      data.profileObservations.push(core.structuredCloneSafe(observation));
      return { player: merged, observation };
    }
    async function recordLeaderboard(namespace, players, capture, entries) {
      const data = get(namespace);
      const mergedPlayers = [];
      const eligibleEntries = [];
      for (let offset = 0; offset < (players || []).length; offset += 1) {
        const player = players[offset];
        const index = data.players.findIndex(
          (item) => (player.characterId != null && item.characterId === player.characterId) || item.normalizedName === player.normalizedName
        );
        const existing = index >= 0 ? data.players[index] : null;
        const merged = core.mergePlayer(existing, player);
        if (existing && existing.playerKey !== merged.playerKey) {
          for (const event of [...data.profileObservations, ...data.inviteEvents, ...data.leaderboardEntries]) {
            if (event.playerKey === existing.playerKey) event.playerKey = merged.playerKey;
          }
        }
        if (entries[offset]) {
          entries[offset].playerKey = merged.playerKey;
          if (isEligibleLeaderboardEntry(merged, entries[offset])) {
            eligibleEntries.push({
              ...entries[offset],
              noGuildConfirmedAtCapture: true
            });
          }
        }
        if (index >= 0) data.players[index] = merged;
        else data.players.push(merged);
        mergedPlayers.push(core.structuredCloneSafe(merged));
      }
      const storedCapture = { ...capture, eligibleRowCount: eligibleEntries.length };
      data.leaderboardCaptures.push(core.structuredCloneSafe(storedCapture));
      data.leaderboardEntries.push(...core.structuredCloneSafe(eligibleEntries));
      return { players: mergedPlayers, capture: storedCapture, entries: eligibleEntries };
    }
    async function recordInvite(namespace, player, invite) {
      const data = get(namespace);
      const index = data.players.findIndex((item) => item.normalizedName === player.normalizedName);
      const merged = core.mergePlayer(index >= 0 ? data.players[index] : null, player);
      if (index >= 0) data.players[index] = merged;
      else data.players.push(merged);
      invite.playerKey = merged.playerKey;
      data.inviteEvents.push(core.structuredCloneSafe(invite));
      return { player: merged, invite };
    }
    async function upsertPlayers(namespace, players) {
      const data = get(namespace);
      const mergedPlayers = [];
      for (const player of players || []) {
        if (!player?.normalizedName) continue;
        const index = data.players.findIndex(
          (item) =>
            (player.characterId != null && item.characterId === player.characterId) ||
            item.normalizedName === player.normalizedName
        );
        const existing = index >= 0 ? data.players[index] : null;
        const merged = core.mergePlayer(existing, player);
        if (existing && existing.playerKey !== merged.playerKey) {
          for (const event of [...data.profileObservations, ...data.inviteEvents, ...data.leaderboardEntries]) {
            if (event.playerKey === existing.playerKey) event.playerKey = merged.playerKey;
          }
        }
        if (index >= 0) data.players[index] = merged;
        else data.players.push(merged);
        mergedPlayers.push(core.structuredCloneSafe(merged));
      }
      return mergedPlayers;
    }
    async function updateInvite(namespace, invite) {
      const data = get(namespace);
      const index = data.inviteEvents.findIndex((event) => event.id === invite.id);
      const next = index >= 0 ? { ...invite, playerKey: data.inviteEvents[index].playerKey } : invite;
      if (index >= 0) data.inviteEvents[index] = core.structuredCloneSafe(next);
      return next;
    }
    async function deletePlayer(namespace, key) {
      const data = get(namespace);
      data.players = data.players.filter((item) => item.playerKey !== key);
      data.profileObservations = data.profileObservations.filter((item) => item.playerKey !== key);
      data.inviteEvents = data.inviteEvents.filter((item) => item.playerKey !== key);
      data.leaderboardEntries = data.leaderboardEntries.filter((item) => item.playerKey !== key);
    }
    async function clearNamespace(namespace) {
      spaces.set(namespace, { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] });
    }
    return {
      namespaceFor,
      snapshot,
      replaceSnapshot,
      recordObservation,
      recordLeaderboard,
      recordInvite,
      upsertPlayers,
      updateInvite,
      deletePlayer,
      clearNamespace,
      close: async () => {}
    };
  }

  app.storage = Object.freeze({
    STORE_NAMES,
    namespaceFor,
    openDatabase,
    createRepository,
    createMemoryRepository,
    publicRecord
  });
})(globalThis);

// ---- src/runtime/import-export.js ----
(function initImportExport(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function cleanFilename(value) {
    return String(value || "character")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .slice(0, 60) || "character";
  }

  function stableData(data, schemaVersion = app.config.schemaVersion) {
    const normalized = {
      players: [...(data.players || [])].sort((a, b) => a.playerKey.localeCompare(b.playerKey)),
      profileObservations: [...(data.profileObservations || [])].sort((a, b) => a.id.localeCompare(b.id)),
      inviteEvents: [...(data.inviteEvents || [])].sort((a, b) => a.id.localeCompare(b.id)),
      leaderboardCaptures: [...(data.leaderboardCaptures || [])].sort((a, b) => a.id.localeCompare(b.id)),
      leaderboardEntries: [...(data.leaderboardEntries || [])].sort((a, b) => a.id.localeCompare(b.id))
    };
    if (schemaVersion === 1) {
      delete normalized.leaderboardCaptures;
      delete normalized.leaderboardEntries;
    }
    return normalized;
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    if (root.crypto?.subtle) {
      const digest = await root.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return null;
  }

  async function createBackup(data, source, exportedAt = new Date().toISOString()) {
    const normalized = stableData(data);
    const checksumValue = await sha256(JSON.stringify(normalized));
    return {
      format: app.config.appId,
      schemaVersion: app.config.schemaVersion,
      pluginVersion: app.config.version,
      exportedAt,
      source: {
        hostname: String(source?.hostname || "unknown"),
        characterId: core.nullableNumber(source?.characterId),
        characterName: String(source?.characterName || "")
      },
      counts: {
        players: normalized.players.length,
        profileObservations: normalized.profileObservations.length,
        inviteEvents: normalized.inviteEvents.length,
        leaderboardCaptures: normalized.leaderboardCaptures.length,
        leaderboardEntries: normalized.leaderboardEntries.length
      },
      checksum: checksumValue ? { algorithm: "SHA-256", value: checksumValue } : null,
      data: normalized
    };
  }

  function validatePlayer(player) {
    return Boolean(
      player &&
        typeof player.playerKey === "string" &&
        typeof player.currentName === "string" &&
        typeof player.normalizedName === "string" &&
        core.isIsoDate(player.firstSeenAt) &&
        core.isIsoDate(player.lastSeenAt) &&
        Array.isArray(player.nameAliases)
    );
  }

  function validateObservation(event, keys) {
    return Boolean(
      event &&
        typeof event.id === "string" &&
        keys.has(event.playerKey) &&
        typeof event.characterName === "string" &&
        core.isIsoDate(event.viewedAt) &&
        event.guildSnapshot &&
        (event.guildSnapshot.state === "joined" || event.guildSnapshot.state === "none") &&
        (!event.activitySnapshot ||
          (core.ACTIVITY_STATES.has(event.activitySnapshot.state) &&
            core.isIsoDate(event.activitySnapshot.observedAt)))
    );
  }

  function validateInvite(event, keys) {
    return Boolean(
      event &&
        typeof event.id === "string" &&
        keys.has(event.playerKey) &&
        typeof event.requestedName === "string" &&
        (event.attemptedAt === null || core.isIsoDate(event.attemptedAt)) &&
        core.OUTCOMES.has(event.outcome)
    );
  }

  function validateCapture(event) {
    return Boolean(event && typeof event.id === "string" && core.isIsoDate(event.capturedAt) && Number.isInteger(event.rowCount));
  }

  function validateLeaderboardEntry(event, keys, captureIds) {
    const eligibilityValid = event?.noGuildConfirmedAtCapture === undefined || (
      event.noGuildConfirmedAtCapture === true && core.nullableNumber(event.experienceValue) !== null
    );
    return Boolean(
      event && typeof event.id === "string" && keys.has(event.playerKey) && captureIds.has(event.captureId) &&
      typeof event.name === "string" && core.isIsoDate(event.capturedAt) && eligibilityValid
    );
  }

  async function validateBackup(backup) {
    const errors = [];
    if (!backup || backup.format !== app.config.appId) errors.push("format");
    if (!Number.isInteger(backup?.schemaVersion)) errors.push("schemaVersion");
    else if (backup.schemaVersion > app.config.schemaVersion) errors.push("futureVersion");
    else if (backup.schemaVersion < 1) errors.push("unsupportedVersion");
    if (!core.isIsoDate(backup?.exportedAt)) errors.push("exportedAt");
    if (!backup?.source || typeof backup.source.hostname !== "string") errors.push("source");
    const data = backup?.data;
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.profileObservations) || !Array.isArray(data.inviteEvents)) {
      errors.push("data");
      return { valid: false, errors };
    }
    if (backup.schemaVersion >= 2 && (!Array.isArray(data.leaderboardCaptures) || !Array.isArray(data.leaderboardEntries))) {
      errors.push("data");
      return { valid: false, errors };
    }
    if (
      !backup.counts ||
      backup.counts.players !== data.players.length ||
      backup.counts.profileObservations !== data.profileObservations.length ||
      backup.counts.inviteEvents !== data.inviteEvents.length ||
      (backup.schemaVersion >= 2 && backup.counts.leaderboardCaptures !== data.leaderboardCaptures.length) ||
      (backup.schemaVersion >= 2 && backup.counts.leaderboardEntries !== data.leaderboardEntries.length)
    ) {
      errors.push("counts");
    }
    const playerKeys = new Set();
    const ids = new Set();
    for (const player of data.players) {
      if (!validatePlayer(player) || playerKeys.has(player.playerKey)) errors.push("player");
      playerKeys.add(player.playerKey);
    }
    for (const event of data.profileObservations) {
      if (!validateObservation(event, playerKeys) || ids.has(`observation:${event.id}`)) errors.push("observation");
      ids.add(`observation:${event.id}`);
    }
    for (const event of data.inviteEvents) {
      if (!validateInvite(event, playerKeys) || ids.has(`invite:${event.id}`)) errors.push("invite");
      ids.add(`invite:${event.id}`);
    }
    const captureIds = new Set();
    for (const capture of data.leaderboardCaptures || []) {
      if (!validateCapture(capture) || captureIds.has(capture.id)) errors.push("leaderboardCapture");
      captureIds.add(capture.id);
    }
    for (const entry of data.leaderboardEntries || []) {
      if (!validateLeaderboardEntry(entry, playerKeys, captureIds) || ids.has(`leaderboard:${entry.id}`)) errors.push("leaderboardEntry");
      ids.add(`leaderboard:${entry.id}`);
    }
    if (backup.checksum?.algorithm === "SHA-256") {
      const actual = await sha256(JSON.stringify(stableData(data, backup.schemaVersion)));
      if (actual && actual !== backup.checksum.value) errors.push("checksum");
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
  }

  async function parseBackupText(text) {
    if (new TextEncoder().encode(text).byteLength > app.config.maxImportBytes) {
      throw new Error("backup_too_large");
    }
    let backup;
    try {
      backup = JSON.parse(text);
    } catch (_error) {
      throw new Error("invalid_json");
    }
    const validation = await validateBackup(backup);
    if (!validation.valid) throw new Error(`invalid_backup:${validation.errors.join(",")}`);
    if (backup.schemaVersion === app.config.schemaVersion) return backup;
    const data = stableData(backup.data);
    return {
      ...backup,
      schemaVersion: app.config.schemaVersion,
      pluginVersion: app.config.version,
      counts: {
        players: data.players.length,
        profileObservations: data.profileObservations.length,
        inviteEvents: data.inviteEvents.length,
        leaderboardCaptures: data.leaderboardCaptures.length,
        leaderboardEntries: data.leaderboardEntries.length
      },
      checksum: null,
      data
    };
  }

  function identityMatches(source, identity) {
    return (
      String(source?.hostname || "").toLowerCase() === String(identity?.hostname || "").toLowerCase() &&
      Number(source?.characterId) === Number(identity?.characterId)
    );
  }

  function previewImport(current, backup, identity) {
    const currentPlayerKeys = new Set(current.players.map((record) => record.playerKey));
    const currentObservationIds = new Set(current.profileObservations.map((record) => record.id));
    const currentInviteIds = new Set(current.inviteEvents.map((record) => record.id));
    const currentCaptureIds = new Set((current.leaderboardCaptures || []).map((record) => record.id));
    const currentEntryIds = new Set((current.leaderboardEntries || []).map((record) => record.id));
    return {
      source: backup.source,
      exportedAt: backup.exportedAt,
      schemaVersion: backup.schemaVersion,
      crossIdentity: !identityMatches(backup.source, identity),
      counts: backup.counts,
      duplicates: {
        players: backup.data.players.filter((record) => currentPlayerKeys.has(record.playerKey)).length,
        profileObservations: backup.data.profileObservations.filter((record) => currentObservationIds.has(record.id)).length,
        inviteEvents: backup.data.inviteEvents.filter((record) => currentInviteIds.has(record.id)).length,
        leaderboardCaptures: backup.data.leaderboardCaptures.filter((record) => currentCaptureIds.has(record.id)).length,
        leaderboardEntries: backup.data.leaderboardEntries.filter((record) => currentEntryIds.has(record.id)).length
      }
    };
  }

  function mergeSnapshots(current, incoming, strategy = "merge") {
    if (strategy === "replace") {
      const data = core.structuredCloneSafe(stableData(incoming));
      return {
        data,
        report: {
          addedPlayers: data.players.length,
          mergedPlayers: 0,
          addedObservations: data.profileObservations.length,
          skippedObservations: 0,
          addedInvites: data.inviteEvents.length,
          addedLeaderboardCaptures: data.leaderboardCaptures.length,
          addedLeaderboardEntries: data.leaderboardEntries.length,
          skippedInvites: 0,
          replaced: true
        }
      };
    }
    const players = new Map(current.players.map((record) => [record.playerKey, core.structuredCloneSafe(record)]));
    const byCharacter = new Map(
      current.players.filter((record) => record.characterId != null).map((record) => [Number(record.characterId), record.playerKey])
    );
    const byName = new Map(current.players.map((record) => [record.normalizedName, record.playerKey]));
    const remap = new Map();
    const keyUpgrades = new Map();
    let addedPlayers = 0;
    let mergedPlayers = 0;
    for (const player of incoming.players) {
      const matchKey =
        (player.characterId != null && byCharacter.get(Number(player.characterId))) || byName.get(player.normalizedName);
      if (!matchKey) {
        players.set(player.playerKey, core.structuredCloneSafe(player));
        byName.set(player.normalizedName, player.playerKey);
        if (player.characterId != null) byCharacter.set(Number(player.characterId), player.playerKey);
        remap.set(player.playerKey, player.playerKey);
        addedPlayers += 1;
      } else {
        let resolvedKey = matchKey;
        if (strategy === "merge") {
          const merged = core.mergePlayer(players.get(matchKey), player);
          resolvedKey = merged.playerKey;
          if (resolvedKey !== matchKey) {
            players.delete(matchKey);
            keyUpgrades.set(matchKey, resolvedKey);
          }
          players.set(resolvedKey, merged);
          byName.set(merged.normalizedName, resolvedKey);
          if (merged.characterId != null) byCharacter.set(Number(merged.characterId), resolvedKey);
        }
        remap.set(player.playerKey, resolvedKey);
        mergedPlayers += 1;
      }
    }
    function mergeEvents(name) {
      const hasPlayerKey = name !== "leaderboardCaptures";
      const existing = new Map(
        (current[name] || []).map((record) => {
          const next = core.structuredCloneSafe(record);
          if (hasPlayerKey) next.playerKey = keyUpgrades.get(record.playerKey) || record.playerKey;
          return [record.id, next];
        })
      );
      let added = 0;
      let skipped = 0;
      for (const record of incoming[name] || []) {
        if (existing.has(record.id)) {
          skipped += 1;
          continue;
        }
        const next = core.structuredCloneSafe(record);
        if (hasPlayerKey) next.playerKey = remap.get(record.playerKey) || record.playerKey;
        existing.set(next.id, next);
        added += 1;
      }
      return { values: [...existing.values()], added, skipped };
    }
    const observations = mergeEvents("profileObservations");
    const invites = mergeEvents("inviteEvents");
    const captures = mergeEvents("leaderboardCaptures");
    const leaderboardEntries = mergeEvents("leaderboardEntries");
    return {
      data: {
        players: [...players.values()],
        profileObservations: observations.values,
        inviteEvents: invites.values,
        leaderboardCaptures: captures.values,
        leaderboardEntries: leaderboardEntries.values
      },
      report: {
        addedPlayers,
        mergedPlayers,
        addedObservations: observations.added,
        skippedObservations: observations.skipped,
        addedInvites: invites.added,
        skippedInvites: invites.skipped,
        addedLeaderboardCaptures: captures.added,
        skippedLeaderboardCaptures: captures.skipped,
        addedLeaderboardEntries: leaderboardEntries.added,
        skippedLeaderboardEntries: leaderboardEntries.skipped
      }
    };
  }

  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csv(rows) {
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  function createCsvExports(data) {
    const players = [
      ["playerKey", "characterId", "currentName", "aliases", "guildState", "guildName", "guildRole", "guildObservedAt", "lastViewedAt", "lastInvitedAt"],
      ...data.players.map((player) => [
        player.playerKey,
        player.characterId,
        player.currentName,
        (player.nameAliases || []).join(" | "),
        player.latestGuild?.state,
        player.latestGuild?.guildName,
        player.latestGuild?.guildRole,
        player.latestGuild?.observedAt,
        player.lastViewedAt,
        player.lastInvitedAt
      ])
    ];
    const observations = [
      ["id", "playerKey", "characterName", "viewedAt", "source", "leaderboardType", "leaderboardCategory", "rank", "value1", "value2", "guildState", "guildName", "guildRole", "activityState"],
      ...data.profileObservations.map((event) => [
        event.id,
        event.playerKey,
        event.characterName,
        event.viewedAt,
        event.source,
        event.leaderboard?.typeHrid,
        event.leaderboard?.categoryHrid,
        event.leaderboard?.rank,
        event.leaderboard?.value1,
        event.leaderboard?.value2,
        event.guildSnapshot?.state,
        event.guildSnapshot?.guildName,
        event.guildSnapshot?.guildRole,
        core.activityStateForObservation(event)
      ])
    ];
    const invites = [
      ["id", "playerKey", "requestedName", "attemptedAt", "confirmedAt", "detectedAt", "outcome", "errorKey", "correlation", "hostname", "recruiterCharacterId", "guildName"],
      ...data.inviteEvents.map((event) => [
        event.id,
        event.playerKey,
        event.requestedName,
        event.attemptedAt,
        event.confirmedAt,
        event.detectedAt,
        event.outcome,
        event.errorKey,
        event.correlation,
        event.recruiter?.hostname,
        event.recruiter?.characterId,
        event.recruiter?.guildName
      ])
    ];
    const leaderboardCaptures = [
      ["id", "typeHrid", "categoryHrid", "filterKey", "requestedAt", "capturedAt", "revision", "rowCount", "eligibleRowCount", "columnNames"],
      ...(data.leaderboardCaptures || []).map((event) => [
        event.id, event.typeHrid, event.categoryHrid, event.filterKey, event.requestedAt, event.capturedAt,
        event.revision, event.rowCount, event.eligibleRowCount, (event.columnNames || []).join(" | ")
      ])
    ];
    const leaderboardEntries = [
      ["id", "captureId", "playerKey", "name", "typeHrid", "categoryHrid", "filterKey", "rank", "value1", "value2", "experienceValue", "noGuildConfirmedAtCapture", "capturedAt"],
      ...(data.leaderboardEntries || []).map((event) => [
        event.id, event.captureId, event.playerKey, event.name, event.typeHrid, event.categoryHrid,
        event.filterKey, event.rank, event.value1, event.value2, event.experienceValue,
        event.noGuildConfirmedAtCapture, event.capturedAt
      ])
    ];
    return {
      players: csv(players),
      profileObservations: csv(observations),
      inviteEvents: csv(invites),
      leaderboardCaptures: csv(leaderboardCaptures),
      leaderboardEntries: csv(leaderboardEntries)
    };
  }

  function downloadText(text, filename, type = "application/json;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    root.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function backupFilename(source, extension = "json") {
    const date = new Date().toISOString().slice(0, 10);
    return `${app.config.appId}-${cleanFilename(source?.characterName)}-${date}-v${app.config.version}.${extension}`;
  }

  app.importExport = Object.freeze({
    cleanFilename,
    stableData,
    sha256,
    createBackup,
    validateBackup,
    parseBackupText,
    identityMatches,
    previewImport,
    mergeSnapshots,
    csvCell,
    createCsvExports,
    downloadText,
    backupFilename
  });
})(globalThis);

// ---- src/runtime/scheduler.js ----
(function initScheduler(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  function frameScheduler(callback) {
    let frame = 0;
    let destroyed = false;
    function request() {
      if (destroyed || frame) return;
      const raf = root.requestAnimationFrame || ((fn) => root.setTimeout(fn, 16));
      frame = raf(() => {
        frame = 0;
        if (!destroyed) callback();
      });
    }
    function destroy() {
      destroyed = true;
      if (frame && root.cancelAnimationFrame) root.cancelAnimationFrame(frame);
      frame = 0;
    }
    return { request, destroy };
  }

  app.scheduler = Object.freeze({ frameScheduler });
})(globalThis);

// ---- src/runtime/display-preferences.js ----
(function initDisplayPreferences(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const defaults = Object.freeze({ leaderboard: true, chat: true });

  function normalize(value) {
    return {
      leaderboard: value?.leaderboard !== false,
      chat: value?.chat !== false
    };
  }

  function createStore(storage, key) {
    function load() {
      try {
        return normalize(JSON.parse(storage?.getItem(key) || "null"));
      } catch (_error) {
        return normalize(defaults);
      }
    }

    function save(value) {
      const next = normalize(value);
      try {
        storage?.setItem(key, JSON.stringify(next));
      } catch (_error) {
        // The current session still uses the selected values when storage is unavailable.
      }
      return next;
    }

    return Object.freeze({ load, save });
  }

  app.displayPreferences = Object.freeze({ defaults, normalize, createStore });
})(globalThis);

// ---- src/ui/dom.js ----
(function initDom(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  function element(tag, options = {}, children = []) {
    const node = root.document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text != null) node.textContent = String(options.text);
    if (options.type) node.type = options.type;
    if (options.title) node.title = options.title;
    for (const [name, value] of Object.entries(options.attributes || {})) {
      if (value != null) node.setAttribute(name, String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child) node.append(child);
    }
    return node;
  }

  function clear(node) {
    node.replaceChildren();
    return node;
  }

  function formatDate(value, language, options = {}) {
    if (!value || !Number.isFinite(Date.parse(value))) return "—";
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...options
    }).format(new Date(value));
  }

  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    return () => node.removeEventListener(type, handler, options);
  }

  app.dom = Object.freeze({ element, clear, formatDate, listen });
})(globalThis);

// ---- src/ui/styles.js ----
(function initStyles(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const css = `
    :root {
      --mwi-git-space: #0f1621;
      --mwi-git-panel: #151e2c;
      --mwi-git-panel-2: #1b2737;
      --mwi-git-metal: #314257;
      --mwi-git-text: #edf1f5;
      --mwi-git-muted: #9aabc0;
      --mwi-git-scan: #57d5ca;
      --mwi-git-warning: #e5a94d;
      --mwi-git-error: #e46f61;
      --mwi-git-shield: #7299c7;
      --mwi-git-shadow: rgba(0, 0, 0, 0.46);
    }
    #mwi-git-launcher {
      position: fixed;
      right: 18px;
      bottom: 72px;
      z-index: 2147483000;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      padding: 0 14px 0 11px;
      border: 1px solid var(--mwi-git-metal);
      border-radius: 9px;
      color: var(--mwi-git-text);
      background: linear-gradient(135deg, #162438 0%, #111b28 100%);
      box-shadow: 0 10px 30px var(--mwi-git-shadow), inset 0 1px rgba(255,255,255,.05);
      font: 600 13px/1.2 inherit;
      letter-spacing: .03em;
      cursor: pointer;
    }
    #mwi-git-launcher[hidden] { display: none; }
    #mwi-git-launcher::before {
      content: "";
      width: 9px;
      height: 9px;
      border: 1px solid var(--mwi-git-scan);
      border-radius: 50%;
      box-shadow: 0 0 0 3px rgba(76,201,192,.10), 0 0 12px rgba(76,201,192,.5);
    }
    #mwi-git-launcher:hover { border-color: var(--mwi-git-scan); }
    #mwi-git-launcher:focus-visible,
    .mwi-git-panel button:focus-visible,
    .mwi-git-panel input:focus-visible,
    .mwi-git-panel select:focus-visible,
    .mwi-git-guild-marker:focus-visible {
      outline: 2px solid var(--mwi-git-scan);
      outline-offset: 2px;
    }
    .mwi-git-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483001;
      display: grid;
      justify-items: end;
      background: rgba(5, 9, 15, .62);
      backdrop-filter: blur(3px);
    }
    .mwi-git-backdrop[hidden] { display: none; }
    .mwi-git-panel {
      width: min(980px, calc(100vw - 24px));
      height: 100%;
      color: var(--mwi-git-text);
      background:
        linear-gradient(90deg, rgba(76,201,192,.04), transparent 14%),
        var(--mwi-git-space);
      border-left: 1px solid var(--mwi-git-metal);
      box-shadow: -22px 0 60px var(--mwi-git-shadow);
      font-family: inherit;
      overflow: hidden;
      animation: mwi-git-enter 170ms ease-out;
    }
    .mwi-git-panel[hidden] { display: none; }
    .mwi-git-panel ::selection { color: #081316; background: rgba(87,213,202,.86); }
    .mwi-git-panel * { scrollbar-width: thin; scrollbar-color: var(--mwi-git-metal) transparent; }
    .mwi-git-panel *::-webkit-scrollbar { width: 7px; height: 7px; }
    .mwi-git-panel *::-webkit-scrollbar-thumb { border-radius: 8px; background: var(--mwi-git-metal); }
    .mwi-git-panel *::-webkit-scrollbar-track { background: transparent; }
    [data-mwi-git-tab="true"] { user-select: none; pointer-events: auto !important; cursor: pointer !important; }
    .mwi-git-panel--native {
      position: relative;
      z-index: 0;
      box-sizing: border-box;
      flex: 1;
      width: 100%;
      min-width: 0;
      min-height: 0;
      height: 100%;
      margin: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      overflow: hidden;
      animation: none;
      container-type: inline-size;
    }
    @keyframes mwi-git-enter { from { transform: translateX(18px); opacity: .7; } }
    .mwi-git-shell { height: 100%; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr); }
    .mwi-git-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 14px 10px;
      border-bottom: 1px solid var(--mwi-git-metal);
      background: linear-gradient(180deg, rgba(49,66,87,.18), rgba(15,22,33,.25));
    }
    .mwi-git-title-block { min-width: 0; flex: 1; }
    .mwi-git-title { margin: 0; font-size: 17px; line-height: 1.2; letter-spacing: .01em; }
    .mwi-git-header-meta { display: flex; min-width: 0; align-items: center; gap: 6px 10px; margin-top: 4px; color: var(--mwi-git-muted); font-size: 10px; line-height: 1.25; }
    .mwi-git-local { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; }
    .mwi-git-local::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--mwi-git-scan); }
    .mwi-git-identity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mwi-git-icon-button,
    .mwi-git-button {
      border: 1px solid var(--mwi-git-metal);
      border-radius: 5px;
      color: var(--mwi-git-text);
      background: var(--mwi-git-panel-2);
      font: 600 12px/1 inherit;
      cursor: pointer;
    }
    .mwi-git-icon-button { width: 30px; height: 30px; font-size: 17px; }
    .mwi-git-button { min-height: 30px; padding: 0 9px; }
    .mwi-git-button:hover, .mwi-git-icon-button:hover { border-color: var(--mwi-git-scan); background: #213044; }
    .mwi-git-button--danger { color: #ffd7d2; border-color: rgba(228,111,97,.55); }
    .mwi-git-settings-button { min-height: 28px; white-space: nowrap; }
    .mwi-git-settings-button[aria-expanded="true"] { color: var(--mwi-git-scan); border-color: rgba(87,213,202,.58); }
    .mwi-git-display-settings {
      display: grid;
      grid-template-columns: minmax(100px, 1fr) repeat(2, minmax(92px, auto));
      align-items: center;
      gap: 6px 14px;
      padding: 7px 14px;
      border-bottom: 1px solid rgba(52,70,91,.72);
      background: var(--mwi-git-panel);
    }
    .mwi-git-display-settings[hidden] { display: none; }
    .mwi-git-display-settings h3 { margin: 0; color: var(--mwi-git-muted); font-size: 12px; }
    .mwi-git-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; cursor: pointer; }
    .mwi-git-switch {
      position: relative;
      box-sizing: border-box;
      width: 30px;
      height: 17px;
      flex: 0 0 auto;
      margin: 0;
      border: 1px solid var(--mwi-git-metal);
      border-radius: 999px;
      appearance: none;
      background: #101a28;
      cursor: pointer;
      transition: border-color 140ms ease, background 140ms ease;
    }
    .mwi-git-switch::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--mwi-git-muted);
      transition: transform 140ms ease, background 140ms ease;
    }
    .mwi-git-switch:checked { border-color: var(--mwi-git-scan); background: rgba(76,201,192,.18); }
    .mwi-git-switch:checked::after { background: var(--mwi-git-scan); transform: translateX(13px); }
    .mwi-git-collapsible { min-width: 0; background: var(--mwi-git-panel); }
    .mwi-git-section-toggle {
      box-sizing: border-box;
      width: 100%;
      min-height: 27px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 12px;
      border: 0;
      border-bottom: 1px solid rgba(52,70,91,.7);
      color: var(--mwi-git-muted);
      background: rgba(13,20,32,.96);
      font: 650 11px/1.3 inherit;
      letter-spacing: .04em;
      text-align: left;
      cursor: pointer;
    }
    .mwi-git-section-toggle:hover { color: var(--mwi-git-text); background: rgba(27,40,57,.96); }
    .mwi-git-section-chevron {
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      margin-top: -3px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      transition: transform 140ms ease;
    }
    [data-collapsed="true"] > .mwi-git-section-toggle .mwi-git-section-chevron { margin-top: 2px; transform: rotate(-45deg); }
    .mwi-git-collapsible > [hidden],
    .mwi-git-list-pane > [hidden],
    .mwi-git-detail-pane > [hidden] { display: none !important; }
    .mwi-git-toolbar {
      display: grid;
      grid-template-columns: minmax(170px, 1.35fr) repeat(3, minmax(112px, .8fr));
      gap: 6px;
      padding: 8px 14px;
      border-bottom: 1px solid rgba(52,70,91,.72);
      background: var(--mwi-git-panel);
    }
    .mwi-git-input,
    .mwi-git-select {
      min-width: 0;
      height: 31px;
      padding: 0 9px;
      border: 1px solid var(--mwi-git-metal);
      border-radius: 5px;
      color: var(--mwi-git-text);
      background: #101a28;
      font: 12px/1 inherit;
    }
    .mwi-git-input::placeholder { color: #8394aa; }
    .mwi-git-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 7px 14px; border-bottom: 1px solid rgba(49,66,87,.72); }
    .mwi-git-summary { min-width: 0; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .mwi-git-body { min-height: 0; display: grid; grid-template-columns: minmax(280px, 39%) 1fr; }
    .mwi-git-list-pane, .mwi-git-detail-pane { min-height: 0; overflow: auto; }
    .mwi-git-list-pane { border-right: 1px solid var(--mwi-git-metal); background: rgba(21,31,46,.75); }
    .mwi-git-list-pane > .mwi-git-section-toggle,
    .mwi-git-detail-pane > .mwi-git-section-toggle { position: sticky; top: 0; z-index: 2; }
    .mwi-git-detail-content { min-height: 0; }
    .mwi-git-body[data-players-collapsed="true"] { grid-template-columns: minmax(120px, 20%) 1fr; }
    .mwi-git-body[data-timeline-collapsed="true"] { grid-template-columns: 1fr minmax(120px, 20%); }
    .mwi-git-body[data-players-collapsed="true"][data-timeline-collapsed="true"] {
      grid-template-columns: 1fr 1fr;
      align-content: start;
    }
    .mwi-git-player {
      box-sizing: border-box;
      width: 100%;
      height: 49px;
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px 12px;
      border: 0;
      border-bottom: 1px solid rgba(52,70,91,.45);
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .mwi-git-player-spacer { width: 1px; pointer-events: none; }
    .mwi-git-player:hover { background: rgba(76,201,192,.055); }
    .mwi-git-player[aria-selected="true"] { background: rgba(87,213,202,.10); box-shadow: inset 2px 0 var(--mwi-git-scan); }
    .mwi-git-player-dot { grid-column: 1; display: block; width: 6px; height: 6px; border-radius: 50%; visibility: hidden; }
    [data-engagement-state="online"] .mwi-git-player-dot { visibility: visible; background: #48d087; box-shadow: 0 0 9px rgba(72,208,135,.45); }
    [data-engagement-state="offline"] .mwi-git-player-dot { visibility: visible; background: #f3f6fa; box-shadow: 0 0 7px rgba(243,246,250,.28); }
    [data-status="has_guild"] .mwi-git-player-dot { visibility: visible; background: #ef646f; }
    [data-status="invited"] .mwi-git-player-dot { visibility: visible; background: var(--mwi-git-warning); }
    [data-status="invite_failed"] .mwi-git-player-dot { visibility: visible; background: var(--mwi-git-error); }
    .mwi-git-player-copy { grid-column: 2; min-width: 0; }
    .mwi-git-player-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; font-size: 12px; }
    .mwi-git-player-meta { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mwi-git-muted); font-size: 10px; }
    .mwi-git-player-time { grid-column: 3; color: var(--mwi-git-muted); font: 10px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .mwi-git-empty { padding: 24px 18px; color: var(--mwi-git-muted); font-size: 12px; line-height: 1.6; text-align: center; }
    .mwi-git-detail-head { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid rgba(49,66,87,.7); }
    .mwi-git-detail-head h3 { min-width: 0; flex: 1; margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 15px; }
    .mwi-git-detail-guild { margin-top: 2px; color: var(--mwi-git-muted); font-size: 10px; }
    .mwi-git-timeline { position: relative; margin: 0; padding: 8px 14px 20px 33px; list-style: none; }
    .mwi-git-timeline::before { content: ""; position: absolute; top: 11px; bottom: 15px; left: 19px; width: 1px; background: linear-gradient(var(--mwi-git-scan), rgba(87,213,202,.10)); }
    .mwi-git-event { position: relative; margin: 0; padding: 8px 0 9px; border-bottom: 1px solid rgba(49,66,87,.45); }
    .mwi-git-event::before { content: ""; position: absolute; left: -17px; top: 13px; width: 6px; height: 6px; border: 2px solid var(--mwi-git-space); border-radius: 50%; background: var(--mwi-git-scan); box-shadow: 0 0 0 1px var(--mwi-git-scan); }
    .mwi-git-event--invite::before { background: var(--mwi-git-warning); box-shadow: 0 0 0 1px var(--mwi-git-warning); }
    .mwi-git-event-title { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700; }
    .mwi-git-event-time { color: var(--mwi-git-muted); font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .mwi-git-event-detail { margin-top: 3px; color: var(--mwi-git-muted); font-size: 10px; line-height: 1.45; }
    .mwi-git-guild-marker {
      --mwi-git-marker-size: 1.2em;
      position: relative;
      display: inline-block;
      box-sizing: border-box;
      width: var(--mwi-git-marker-size);
      height: var(--mwi-git-marker-size);
      margin-inline-end: .35em;
      border: calc(var(--mwi-git-marker-size) * .1) solid currentColor;
      border-radius: 50%;
      color: #818b9d;
      background: #101722;
      box-shadow: 0 2px 8px rgba(0,0,0,.42), inset 0 0 0 2px rgba(255,255,255,.06);
      vertical-align: -.16em;
      cursor: help;
      flex: 0 0 auto;
    }
    .mwi-git-guild-marker::after {
      content: "";
      position: absolute;
      inset: 24%;
      border-radius: 50%;
      background: currentColor;
    }
    .mwi-git-guild-marker[data-state="joined"] { color: #ef646f; }
    .mwi-git-guild-marker[data-state="own_guild"] { color: #aa83f2; }
    .mwi-git-guild-marker[data-state="online"] { color: #48d087; }
    .mwi-git-guild-marker[data-state="offline"] { color: #f3f6fa; }
    .mwi-git-guild-marker[data-state="inviting"] { color: #efbf4d; }
    .mwi-git-marker-host--leaderboard { white-space: nowrap; }
    .mwi-git-invite-age-cell {
      position: relative !important;
      padding-inline-end: 4.75em !important;
    }
    .mwi-git-invite-age {
      position: absolute;
      inset-inline-end: .75em;
      top: 50%;
      transform: translateY(-50%);
      color: var(--mwi-git-warning);
      font: 700 .82em/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      cursor: help;
    }
    .mwi-git-dialog-backdrop { position: fixed; inset: 0; z-index: 2147483010; display: grid; place-items: center; padding: 18px; background: rgba(5,9,15,.76); }
    .mwi-git-dialog { width: min(500px, 100%); max-height: 85vh; overflow: auto; padding: 16px; border: 1px solid var(--mwi-git-metal); border-radius: 8px; color: var(--mwi-git-text); background: var(--mwi-git-panel); box-shadow: 0 24px 70px var(--mwi-git-shadow); }
    .mwi-git-dialog h2 { margin: 0 0 10px; font-size: 16px; }
    .mwi-git-preview { display: grid; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); gap: 6px 14px; margin: 10px 0; padding: 10px 0; border-block: 1px solid rgba(49,66,87,.7); font-size: 11px; }
    .mwi-git-preview > :nth-child(odd) { color: var(--mwi-git-muted); font-weight: 500; }
    .mwi-git-preview > :nth-child(even) { overflow-wrap: anywhere; text-align: right; }
    .mwi-git-warning { color: #ffd99c; font-size: 12px; line-height: 1.5; }
    .mwi-git-dialog-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 14px; }
    .mwi-git-toast { position: fixed; right: 18px; bottom: 124px; z-index: 2147483020; max-width: min(420px, calc(100vw - 36px)); padding: 11px 14px; border: 1px solid var(--mwi-git-metal); border-radius: 7px; color: var(--mwi-git-text); background: var(--mwi-git-panel-2); box-shadow: 0 14px 36px var(--mwi-git-shadow); font-size: 12px; }
    .mwi-git-panel--native .mwi-git-header { gap: 7px; padding: 8px 10px 7px; }
    .mwi-git-panel--native .mwi-git-title { font-size: 15px; }
    .mwi-git-panel--native .mwi-git-header-meta { gap: 5px 8px; margin-top: 3px; font-size: 10px; }
    .mwi-git-panel--native .mwi-git-icon-button { width: 30px; min-width: 30px; height: 30px; }
    .mwi-git-panel--native .mwi-git-toolbar {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 5px;
      padding: 6px 10px;
    }
    .mwi-git-panel--native .mwi-git-toolbar > :first-child { grid-column: 1 / -1; }
    .mwi-git-panel--native .mwi-git-input,
    .mwi-git-panel--native .mwi-git-select { height: 29px; padding-inline: 7px; font-size: 10px; }
    .mwi-git-panel--native .mwi-git-actions { gap: 5px; padding: 6px 10px; }
    .mwi-git-panel--native .mwi-git-display-settings { grid-template-columns: 1fr auto auto; gap: 6px 10px; padding: 6px 10px; }
    .mwi-git-panel--native .mwi-git-switch-row { min-height: 24px; }
    .mwi-git-panel--native .mwi-git-section-toggle { min-height: 25px; padding: 5px 10px; }
    .mwi-git-panel--native .mwi-git-button { min-height: 28px; padding-inline: 7px; font-size: 10px; }
    .mwi-git-panel--native .mwi-git-body {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(160px, 38%) minmax(0, 1fr);
    }
    .mwi-git-panel--native .mwi-git-body[data-players-collapsed="true"] { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
    .mwi-git-panel--native .mwi-git-body[data-timeline-collapsed="true"] { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
    .mwi-git-panel--native .mwi-git-body[data-players-collapsed="true"][data-timeline-collapsed="true"] { grid-template-rows: auto auto; }
    .mwi-git-panel--native .mwi-git-list-pane { border-right: 0; border-bottom: 1px solid var(--mwi-git-metal); }
    .mwi-git-panel--native .mwi-git-player { padding: 7px 10px; }
    .mwi-git-panel--native .mwi-git-detail-head { padding: 8px 10px; }
    .mwi-git-panel--native .mwi-git-detail-head h3 { font-size: 14px; }
    .mwi-git-panel--native .mwi-git-timeline { padding: 6px 10px 18px 31px; }
    .mwi-git-panel--native .mwi-git-timeline::before { left: 18px; }
    .mwi-git-panel--native .mwi-git-event::before { left: -16px; }
    @container (max-width: 350px) {
      .mwi-git-panel--native .mwi-git-toolbar { grid-template-columns: 1fr; }
      .mwi-git-panel--native .mwi-git-toolbar > *,
      .mwi-git-panel--native .mwi-git-toolbar > :first-child,
      .mwi-git-panel--native .mwi-git-local { display: none; }
      .mwi-git-panel--native .mwi-git-summary { display: none; }
      .mwi-git-panel--native .mwi-git-display-settings { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      .mwi-git-panel:not(.mwi-git-panel--native) { width: 100vw; }
      .mwi-git-toolbar { grid-template-columns: 1fr 1fr; }
      .mwi-git-body { grid-template-columns: 1fr; grid-template-rows: minmax(170px, 38%) minmax(0, 1fr); }
      .mwi-git-body[data-players-collapsed="true"] { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
      .mwi-git-body[data-timeline-collapsed="true"] { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
      .mwi-git-body[data-players-collapsed="true"][data-timeline-collapsed="true"] { grid-template-rows: auto auto; }
      .mwi-git-list-pane { border-right: 0; border-bottom: 1px solid var(--mwi-git-metal); }
      .mwi-git-summary { width: 100%; margin: 3px 0 0; }
      .mwi-git-actions { padding-inline: 12px; }
    }
    @media (max-width: 480px) {
      #mwi-git-launcher { right: 10px; bottom: 62px; }
      .mwi-git-header, .mwi-git-toolbar { padding-inline: 12px; }
      .mwi-git-toolbar { grid-template-columns: 1fr; }
      .mwi-git-local { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .mwi-git-panel { animation: none; }
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
  `;

  function installStyles() {
    if (root.document.getElementById("mwi-git-styles")) return;
    const style = root.document.createElement("style");
    style.id = "mwi-git-styles";
    style.textContent = css;
    (root.document.head || root.document.documentElement).append(style);
  }

  app.styles = Object.freeze({ css, installStyles });
})(globalThis);

// ---- src/ui/sidebar-integration.js ----
(function initSidebarIntegration(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const SIDEBAR_LABELS = Object.freeze({
    zh: Object.freeze(["库存", "装备", "技能", "房屋", "配装", "收获"]),
    en: Object.freeze(["Inventory", "Equipment", "Skills", "House", "Loadout", "Loadouts", "Harvest", "Gathering"])
  });
  const EXPECTED_LABELS = new Set([...SIDEBAR_LABELS.zh, ...SIDEBAR_LABELS.en]);
  const SIDEBAR_ACTIVATION_EVENT = "mwi:sidebar-plugin-activated";

  function createActivationCoordinator(options = {}) {
    const eventTarget = options.eventTarget;
    const CustomEventConstructor = options.CustomEvent;
    const owner = String(options.owner || "").trim();
    const onDeactivate = typeof options.onDeactivate === "function" ? options.onDeactivate : () => {};
    let started = false;

    function handleActivation(event) {
      const activeOwner = typeof event?.detail === "string" ? event.detail : "";
      if (activeOwner && activeOwner !== owner) onDeactivate(activeOwner);
    }

    function start() {
      if (started) return true;
      if (!owner || typeof eventTarget?.addEventListener !== "function") return false;
      eventTarget.addEventListener(SIDEBAR_ACTIVATION_EVENT, handleActivation);
      started = true;
      return true;
    }

    function announce() {
      if (!started) start();
      if (!started || typeof eventTarget?.dispatchEvent !== "function" || typeof CustomEventConstructor !== "function") {
        return false;
      }
      eventTarget.dispatchEvent(new CustomEventConstructor(SIDEBAR_ACTIVATION_EVENT, { detail: owner }));
      return true;
    }

    function destroy() {
      if (!started) return;
      eventTarget.removeEventListener(SIDEBAR_ACTIVATION_EVENT, handleActivation);
      started = false;
    }

    return Object.freeze({ start, announce, destroy });
  }

  function createDocumentActivationCoordinator(windowRef, owner, onDeactivate) {
    const coordinator = createActivationCoordinator({
      eventTarget: windowRef?.document,
      CustomEvent: windowRef?.CustomEvent,
      owner,
      onDeactivate
    });
    coordinator.start();
    return coordinator;
  }

  function normalizedLabel(element) {
    return String(element?.innerText || element?.textContent || "")
      .replaceAll("\n", "")
      .trim();
  }

  function sidebarLocale(labels) {
    const counts = { zh: 0, en: 0 };
    for (const label of Array.isArray(labels) ? labels : []) {
      if (SIDEBAR_LABELS.zh.includes(label)) counts.zh += 1;
      else if (SIDEBAR_LABELS.en.includes(label)) counts.en += 1;
    }
    if (counts.zh === counts.en) return null;
    return counts.zh > counts.en ? "zh" : "en";
  }

  function findSidebarIntegration(documentRef, preferredLanguage) {
    if (!documentRef || typeof documentRef.getElementsByTagName !== "function") return null;
    let best = null;
    for (const candidate of Array.from(documentRef.getElementsByTagName("*"))) {
      const children = Array.from(candidate.children || []);
      if (children.length < 4) continue;
      const recognized = children
        .map((element) => ({ element, label: normalizedLabel(element) }))
        .filter((tab) => EXPECTED_LABELS.has(tab.label));
      if (recognized.length < 4) continue;
      const detectedLanguage = sidebarLocale(recognized.map((tab) => tab.label));
      const prototypeLabels = (detectedLanguage || preferredLanguage) === "en"
        ? ["Inventory", "库存"]
        : ["库存", "Inventory"];
      const prototype = recognized.find((tab) => prototypeLabels.includes(tab.label)) || recognized[0];
      const tabsRoot = candidate.parentElement?.parentElement?.parentElement;
      const sidebar = tabsRoot?.parentElement;
      const panelHost = sidebar && Array.from(sidebar.children || []).find(
        (node) => node !== tabsRoot && /tabPanelsContainer/.test(String(node.className))
      );
      if (!panelHost) continue;
      const rect = typeof candidate.getBoundingClientRect === "function"
        ? candidate.getBoundingClientRect()
        : { width: 0, height: 0 };
      const visible = candidate.isConnected !== false && rect.width > 0 && rect.height > 0;
      const integration = {
        tabBar: candidate,
        tabPrototype: prototype.element,
        panelHost,
        detectedLanguage,
        score: (visible ? 1000 : 0) + recognized.length
      };
      if (!best || integration.score > best.score) best = integration;
    }
    return best;
  }

  function createController(options) {
    const panel = options.panel;
    const i18n = options.i18n;
    let integration = null;
    let tab = null;
    let hiddenNodes = [];
    let observer = null;
    let scheduled = 0;
    let tabBarClickHandler = null;
    let tabBarPointerHandler = null;
    let active = false;
    let destroyed = false;
    const activationCoordinator = createDocumentActivationCoordinator(root, app.config.appId, hide);

    function restoreHiddenNodes() {
      for (const node of hiddenNodes) {
        if (!node.isConnected) continue;
        node.style.display = node.dataset.mwiGitPreviousDisplay || "";
        delete node.dataset.mwiGitPreviousDisplay;
      }
      hiddenNodes = [];
    }

    function hide() {
      active = false;
      panel.hideNative();
      if (tab) {
        tab.classList.remove("Mui-selected");
        tab.setAttribute("aria-selected", "false");
      }
      restoreHiddenNodes();
    }

    function show() {
      if (!integration || !tab?.isConnected || !panel.isNativeMounted()) return false;
      activationCoordinator.announce();
      hide();
      hiddenNodes = Array.from(integration.panelHost.children || []).filter((node) => node !== panel.element);
      for (const node of hiddenNodes) {
        node.dataset.mwiGitPreviousDisplay = node.style.display;
        node.style.display = "none";
      }
      for (const nativeTab of Array.from(integration.tabBar.children || [])) {
        nativeTab.classList.remove("Mui-selected");
        nativeTab.setAttribute("aria-selected", "false");
      }
      tab.classList.add("Mui-selected");
      tab.setAttribute("aria-selected", "true");
      active = true;
      panel.openNative();
      return true;
    }

    function clearMount() {
      hide();
      if (integration?.tabBar && tabBarClickHandler) {
        integration.tabBar.removeEventListener("click", tabBarClickHandler);
      }
      if (integration?.tabBar && tabBarPointerHandler) {
        integration.tabBar.removeEventListener("pointerdown", tabBarPointerHandler, true);
      }
      tabBarClickHandler = null;
      tabBarPointerHandler = null;
      tab?.remove();
      tab = null;
      integration = null;
      panel.restoreOverlay();
    }

    function mountedIn(found) {
      return Boolean(
        integration &&
        tab?.isConnected &&
        tab.parentElement === found.tabBar &&
        panel.element.isConnected &&
        panel.element.parentElement === found.panelHost
      );
    }

    function ensure() {
      if (destroyed) return false;
      const found = findSidebarIntegration(root.document, i18n.language);
      if (!found) {
        if (integration && (!tab?.isConnected || !panel.isNativeMounted())) clearMount();
        return false;
      }
      if (mountedIn(found)) {
        panel.disableFallback();
        return true;
      }
      const reopen = active;
      clearMount();
      integration = found;
      tab = found.tabPrototype.cloneNode(true);
      tab.dataset.mwiGitTab = "true";
      tab.classList.remove("Mui-selected");
      tab.removeAttribute("id");
      tab.removeAttribute("disabled");
      tab.removeAttribute("aria-disabled");
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("role", "tab");
      if ("disabled" in tab) tab.disabled = false;
      tab.replaceChildren(root.document.createTextNode(i18n.t("sidebar")));
      const activate = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        show();
      };
      tab.addEventListener("pointerdown", activate, true);
      tab.addEventListener("click", activate, true);
      found.tabBar.append(tab);
      panel.mountNative(found.panelHost, hide);
      tabBarClickHandler = (event) => {
        if (!tab || tab.parentElement !== found.tabBar || !tab.contains(event.target)) hide();
      };
      tabBarPointerHandler = (event) => {
        if (!tab || tab.parentElement !== found.tabBar || !tab.contains(event.target)) hide();
      };
      found.tabBar.addEventListener("pointerdown", tabBarPointerHandler, true);
      found.tabBar.addEventListener("click", tabBarClickHandler);
      panel.disableFallback();
      if (reopen) show();
      return true;
    }

    function scheduleEnsure() {
      if (destroyed || scheduled) return;
      scheduled = root.setTimeout(() => {
        scheduled = 0;
        ensure();
      }, 75);
    }

    function start() {
      if (destroyed) return false;
      activationCoordinator.start();
      const mounted = ensure();
      if (!mounted) scheduleEnsure();
      if (typeof root.MutationObserver === "function" && !observer) {
        observer = new root.MutationObserver(() => {
          if (!integration || !tab?.isConnected || !panel.isNativeMounted()) scheduleEnsure();
        });
        observer.observe(root.document.documentElement || root.document, { childList: true, subtree: true });
      }
      return mounted;
    }

    function open() {
      if (ensure()) return show();
      panel.enableFallback();
      panel.open();
      return false;
    }

    function destroy() {
      destroyed = true;
      if (scheduled) root.clearTimeout(scheduled);
      observer?.disconnect();
      observer = null;
      activationCoordinator.destroy();
      clearMount();
    }

    return Object.freeze({ start, ensure, open, hide, destroy });
  }

  app.sidebarIntegration = Object.freeze({
    SIDEBAR_LABELS,
    SIDEBAR_ACTIVATION_EVENT,
    sidebarLocale,
    findSidebarIntegration,
    createActivationCoordinator,
    createDocumentActivationCoordinator,
    createController
  });
})(globalThis);

// ---- src/ui/leaderboard-decorations.js ----
(function initLeaderboardDecorations(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const RANK_HEADERS = new Set(["排名", "rank"]);
  const NAME_HEADERS = new Set(["名称", "name"]);
  const CHARACTER_NAME_SELECTOR = '[class*="CharacterName_characterName__"]';

  function latestByPlayer(events, dateField) {
    const map = new Map();
    for (const event of events || []) {
      const previous = map.get(event.playerKey);
      const currentTime = Date.parse(event[dateField] || event.detectedAt || 0);
      const previousTime = Date.parse(previous?.[dateField] || previous?.detectedAt || 0);
      if (!previous || currentTime >= previousTime) map.set(event.playerKey, event);
    }
    return map;
  }

  function summaryMaps(data) {
    const index = core.dataIndex(data);
    const byName = new Map();
    for (const player of data.players || []) {
      byName.set(core.normalizeName(player.currentName), player);
      for (const alias of player.nameAliases || []) byName.set(core.normalizeName(alias), player);
    }
    return {
      byName,
      invites: index.invites,
      observations: index.observations,
      observationLists: index.observationLists,
      leaderboardEntries: data.leaderboardEntries || [],
      dataIndex: index
    };
  }

  function normalizedCellText(cell) {
    return String(cell?.innerText || cell?.textContent || "").trim();
  }

  function isLeaderboardTable(table) {
    const cells = Array.from(table?.tHead?.rows?.[0]?.cells || []);
    if (cells.length < 2) return false;
    const rank = normalizedCellText(cells[0]).toLowerCase();
    const name = normalizedCellText(cells[1]).toLowerCase();
    return RANK_HEADERS.has(rank) && NAME_HEADERS.has(name);
  }

  function leaderboardRows(table) {
    const rows = [];
    for (const body of Array.from(table?.tBodies || [])) {
      for (const row of Array.from(body.rows || [])) {
        if (!row.cells || row.cells.length < 2) continue;
        const name = normalizedCellText(row.cells[1]).split("\n")[0].trim();
        if (name) rows.push({ row, cell: row.cells[1], name });
      }
    }
    return rows;
  }

  function isOwnGuild(player, identity) {
    if (player?.latestGuild?.state !== "joined" || !identity) return false;
    const playerGuildId = core.nullableNumber(player.latestGuild.guildId);
    const ownGuildId = core.nullableNumber(identity.guildId);
    if (playerGuildId !== null && ownGuildId !== null) return playerGuildId === ownGuildId;
    const playerGuildName = core.normalizeName(player.latestGuild.guildName);
    const ownGuildName = core.normalizeName(identity.guildName);
    return Boolean(playerGuildName && ownGuildName && playerGuildName === ownGuildName);
  }

  function guildMarkerState(player, invite, identity, observation, assessment) {
    if (isOwnGuild(player, identity)) return "own_guild";
    if (player?.latestGuild?.state === "joined") return "joined";
    if (player?.latestGuild?.state === "none" && ["pending", "sent"].includes(invite?.outcome)) return "inviting";
    if (player?.latestGuild?.state === "none" && ["online", "offline"].includes(assessment?.state)) return assessment.state;
    return "hidden";
  }

  function titleFor(player, observation, invite, identity, i18n, assessment) {
    const state = guildMarkerState(player, invite, identity, observation, assessment);
    const parts = [
      state === "own_guild"
        ? i18n.t("ownGuild")
        : state === "joined"
        ? i18n.t("hasGuild")
        : state === "inviting"
          ? i18n.t("inviting")
        : ["online", "offline"].includes(state)
          ? `${i18n.t("noGuild")} · ${i18n.engagementState(state)}`
          : i18n.t("notChecked")
    ];
    if (state === "joined" && player.latestGuild?.guildName) parts.push(player.latestGuild.guildName);
    if (observation?.leaderboard) {
      parts.push(`${i18n.category(observation.leaderboard.categoryHrid)} · ${i18n.t("rank")} ${observation.leaderboard.rank ?? "—"}`);
    }
    if (player?.lastViewedAt) {
      parts.push(`${i18n.t("checkedAt")} ${app.dom.formatDate(player.lastViewedAt, i18n.language)}`);
    }
    if (state === "inviting" && invite?.attemptedAt) {
      parts.push(`${i18n.t("inviteAttempt")} ${app.dom.formatDate(invite.attemptedAt, i18n.language)}`);
    }
    if (assessment?.latestEvidence) parts.push(i18n.evidence(assessment.latestEvidence));
    return parts.join("\n");
  }

  function visibleTable(table) {
    if (!table?.isConnected || typeof table.getBoundingClientRect !== "function") return false;
    const rect = table.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function markerSizeForCell(cell) {
    const candidates = Array.from(cell?.querySelectorAll?.("img, svg, span") || []);
    for (const node of candidates) {
      if (node.classList?.contains("mwi-git-guild-marker")) continue;
      if (typeof node.getBoundingClientRect !== "function") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12 || rect.width > 48 || rect.height > 48) continue;
      const ratio = rect.width / rect.height;
      if (ratio >= 0.65 && ratio <= 1.5) return Math.round(Math.max(rect.width, rect.height));
    }
    const computed = typeof root.getComputedStyle === "function" ? root.getComputedStyle(cell) : null;
    const fontSize = Number.parseFloat(computed?.fontSize) || 16;
    const lineHeight = Number.parseFloat(computed?.lineHeight);
    const inferred = Number.isFinite(lineHeight) ? Math.min(lineHeight, fontSize * 1.35) : fontSize * 1.2;
    return Math.round(Math.max(16, Math.min(36, inferred)));
  }

  function markerHostForCell(cell) {
    return cell?.querySelector?.(CHARACTER_NAME_SELECTOR) || cell;
  }

  function removeLegacyRails() {
    for (const rail of Array.from(root.document.querySelectorAll(".mwi-git-leaderboard-rail"))) {
      rail.parentElement?.classList?.remove("mwi-git-leaderboard-host");
      rail.remove();
    }
  }

  function updateMarkers(rows, maps, identity, i18n, used) {
    rows.forEach(({ cell, name }) => {
      const host = markerHostForCell(cell);
      const normalizedName = core.normalizeName(name);
      const player = maps.byName.get(normalizedName) || null;
      const observation = player ? maps.observations.get(player.playerKey) : null;
      const invite = player ? maps.invites.get(player.playerKey) : null;
      const assessment = player
        ? core.engagementAssessment(
          player,
          maps.observationLists.get(player.playerKey),
          maps.leaderboardEntries,
          Date.now(),
          { dataIndex: maps.dataIndex }
        )
        : null;
      const state = guildMarkerState(player, invite, identity, observation, assessment);
      let marker = cell.querySelector?.('.mwi-git-guild-marker[data-location="leaderboard"]') || null;
      if (state === "hidden") {
        marker?.remove();
        host.classList?.remove("mwi-git-marker-host--leaderboard");
        return;
      }
      const title = titleFor(player, observation, invite, identity, i18n, assessment);
      if (!marker) marker = app.dom.element("span", {
        className: "mwi-git-guild-marker",
        attributes: { role: "img" }
      });
      marker.dataset.location = "leaderboard";
      marker.dataset.state = state;
      marker.title = title;
      marker.setAttribute("aria-label", `${name}: ${title.replace(/\n/g, ", ")}`);
      marker.style.setProperty("--mwi-git-marker-size", `${markerSizeForCell(host)}px`);
      host.classList?.add("mwi-git-marker-host--leaderboard");
      if (host.firstChild !== marker) host.prepend(marker);
      used.add(marker);
    });
  }

  function clearMarkers() {
    for (const marker of Array.from(root.document.querySelectorAll('.mwi-git-guild-marker[data-location="leaderboard"]'))) {
      marker.parentElement?.classList?.remove("mwi-git-marker-host--leaderboard");
      marker.remove();
    }
  }

  function decorate(data, i18n, identity, enabled = true) {
    const maps = summaryMaps(data);
    for (const legacy of Array.from(root.document.querySelectorAll(".mwi-git-status"))) legacy.remove();
    removeLegacyRails();
    if (!enabled) {
      clearMarkers();
      return;
    }
    const used = new Set();
    for (const table of Array.from(root.document.querySelectorAll("table"))) {
      if (!isLeaderboardTable(table) || !visibleTable(table)) continue;
      const rows = leaderboardRows(table);
      updateMarkers(rows, maps, identity, i18n, used);
    }
    for (const marker of Array.from(root.document.querySelectorAll('.mwi-git-guild-marker[data-location="leaderboard"]'))) {
      if (!used.has(marker)) marker.remove();
    }
  }

  function clear() {
    removeLegacyRails();
    clearMarkers();
    for (const legacy of Array.from(root.document.querySelectorAll(".mwi-git-status"))) legacy.remove();
  }

  app.leaderboardDecorations = Object.freeze({
    latestByPlayer,
    summaryMaps,
    normalizedCellText,
    isLeaderboardTable,
    leaderboardRows,
    isOwnGuild,
    guildMarkerState,
    titleFor,
    markerSizeForCell,
    markerHostForCell,
    decorate,
    clear
  });
})(globalThis);

// ---- src/ui/chat-decorations.js ----
(function initChatDecorations(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const CHAT_NAME_SELECTOR = '[class*="ChatMessage_name__"]';
  const CHARACTER_NAME_SELECTOR = '[class*="CharacterName_characterName__"]';

  function leafTextCandidates(node) {
    const descendants = Array.from(node?.querySelectorAll?.("*") || []);
    const leaves = descendants.filter((child) =>
      !child.classList?.contains("mwi-git-guild-marker") && !(child.children?.length > 0)
    );
    return [node, ...leaves]
      .map((child) => String(child?.innerText || child?.textContent || "").trim())
      .filter((text) => text && text.length <= 64 && /[\p{L}\p{N}]/u.test(text) && !/^\d+$/.test(text));
  }

  function chatCharacterName(node, maps) {
    const characterNode = node?.querySelector?.(CHARACTER_NAME_SELECTOR);
    const candidates = leafTextCandidates(characterNode || node);
    for (const candidate of candidates) {
      const exact = maps.byName.get(core.normalizeName(candidate));
      if (exact) return exact.currentName;
    }
    for (const [normalizedName, player] of maps.byName) {
      if (candidates.some((candidate) => core.normalizeName(candidate).includes(normalizedName))) {
        return player.currentName;
      }
    }
    return candidates.sort((left, right) => right.length - left.length)[0] || "";
  }

  function clear() {
    for (const marker of Array.from(root.document.querySelectorAll('.mwi-git-guild-marker[data-location="chat"]'))) {
      marker.remove();
    }
  }

  function decorate(data, i18n, identity, enabled = true) {
    if (!enabled) {
      clear();
      return;
    }
    const maps = app.leaderboardDecorations.summaryMaps(data);
    const used = new Set();
    for (const nameNode of Array.from(root.document.querySelectorAll(CHAT_NAME_SELECTOR))) {
      if (nameNode.closest?.(".mwi-git-panel")) continue;
      const name = chatCharacterName(nameNode, maps);
      if (!name) continue;
      const player = maps.byName.get(core.normalizeName(name)) || null;
      const observation = player ? maps.observations.get(player.playerKey) : null;
      const invite = player ? maps.invites.get(player.playerKey) : null;
      const assessment = player
        ? core.engagementAssessment(
          player,
          maps.observationLists.get(player.playerKey),
          maps.leaderboardEntries,
          Date.now(),
          { dataIndex: maps.dataIndex }
        )
        : null;
      const state = app.leaderboardDecorations.guildMarkerState(player, invite, identity, observation, assessment);
      let marker = Array.from(nameNode.children || []).find(
        (child) => child.classList?.contains("mwi-git-guild-marker") && child.dataset.location === "chat"
      );
      if (state === "hidden") {
        marker?.remove();
        continue;
      }
      const title = app.leaderboardDecorations.titleFor(player, observation, invite, identity, i18n, assessment);
      if (!marker) marker = app.dom.element("span", {
        className: "mwi-git-guild-marker mwi-git-guild-marker--chat",
        attributes: { role: "img" }
      });
      marker.dataset.location = "chat";
      marker.dataset.state = state;
      marker.title = title;
      marker.setAttribute("aria-label", `${name}: ${title.replace(/\n/g, ", ")}`);
      marker.style.setProperty("--mwi-git-marker-size", `${app.leaderboardDecorations.markerSizeForCell(nameNode)}px`);
      if (nameNode.firstChild !== marker) nameNode.prepend(marker);
      used.add(marker);
    }
    for (const marker of Array.from(root.document.querySelectorAll('.mwi-git-guild-marker[data-location="chat"]'))) {
      if (!used.has(marker)) marker.remove();
    }
  }

  app.chatDecorations = Object.freeze({
    CHAT_NAME_SELECTOR,
    CHARACTER_NAME_SELECTOR,
    leafTextCandidates,
    chatCharacterName,
    decorate,
    clear
  });
})(globalThis);

// ---- src/ui/guild-roster-decorations.js ----
(function initGuildRosterDecorations(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const MEMBER_HEADER = /^(成员|members?)(?:\s|\(|（|$)/i;
  const INVITED_LABELS = new Set(["已邀请", "invited"]);
  const CHARACTER_NAME_SELECTOR = '[class*="CharacterName_characterName__"]';

  function normalizedText(node) {
    return String(node?.innerText || node?.textContent || "").trim();
  }

  function isGuildRosterTable(table) {
    const cells = Array.from(table?.tHead?.rows?.[0]?.cells || []);
    return cells.length >= 2 && MEMBER_HEADER.test(normalizedText(cells[0]));
  }

  function isInvitedRow(row) {
    return Array.from(row?.cells || [])
      .slice(1)
      .some((cell) => INVITED_LABELS.has(normalizedText(cell).toLowerCase()));
  }

  function leafTextCandidates(node) {
    const descendants = Array.from(node?.querySelectorAll?.("*") || []);
    const leaves = descendants.filter((child) =>
      !child.classList?.contains("mwi-git-invite-age") && !(child.children?.length > 0)
    );
    return [node, ...leaves]
      .map(normalizedText)
      .filter((text) => text && text.length <= 64 && /[\p{L}\p{N}]/u.test(text) && !/^\d+$/.test(text));
  }

  function playerForCell(cell, maps) {
    const characterNode = cell?.querySelector?.(CHARACTER_NAME_SELECTOR);
    const candidates = leafTextCandidates(characterNode || cell);
    for (const candidate of candidates) {
      const player = maps.byName.get(core.normalizeName(candidate));
      if (player) return player;
    }
    const possible = Array.from(maps.byName.entries())
      .sort(([left], [right]) => right.length - left.length);
    for (const [normalizedName, player] of possible) {
      if (candidates.some((candidate) => core.normalizeName(candidate).includes(normalizedName))) return player;
    }
    return null;
  }

  function inviteStartedAt(invite) {
    for (const value of [invite?.attemptedAt, invite?.detectedAt, invite?.confirmedAt]) {
      if (value && Number.isFinite(Date.parse(value))) return value;
    }
    return null;
  }

  function formatElapsedHours(value, now = Date.now()) {
    const startedAt = Date.parse(value || "");
    if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt) return "";
    const hours = (now - startedAt) / 3_600_000;
    if (hours < 1) return `${(Math.floor(hours * 10) / 10).toFixed(1)}h`;
    return `${Math.floor(hours)}h`;
  }

  function clear() {
    for (const label of Array.from(root.document.querySelectorAll(".mwi-git-invite-age"))) {
      label.parentElement?.classList?.remove("mwi-git-invite-age-cell");
      label.remove();
    }
  }

  function decorate(data, i18n, now = Date.now()) {
    const maps = app.leaderboardDecorations.summaryMaps(data);
    const used = new Set();
    for (const table of Array.from(root.document.querySelectorAll("table"))) {
      if (!isGuildRosterTable(table)) continue;
      for (const body of Array.from(table.tBodies || [])) {
        for (const row of Array.from(body.rows || [])) {
          if (!row.cells?.length || !isInvitedRow(row)) continue;
          const cell = row.cells[0];
          const player = playerForCell(cell, maps);
          const invite = player ? maps.invites.get(player.playerKey) : null;
          const startedAt = inviteStartedAt(invite);
          const elapsed = formatElapsedHours(startedAt, now);
          if (!elapsed) continue;
          let label = cell.querySelector?.(".mwi-git-invite-age") || null;
          if (!label) label = app.dom.element("time", { className: "mwi-git-invite-age" });
          label.textContent = elapsed;
          label.dateTime = startedAt;
          label.title = `${i18n.t("inviteAttempt")} ${app.dom.formatDate(startedAt, i18n.language)}`;
          label.setAttribute("aria-label", label.title);
          cell.classList?.add("mwi-git-invite-age-cell");
          if (label.parentElement !== cell) cell.append(label);
          used.add(label);
        }
      }
    }
    for (const label of Array.from(root.document.querySelectorAll(".mwi-git-invite-age"))) {
      if (used.has(label)) continue;
      label.parentElement?.classList?.remove("mwi-git-invite-age-cell");
      label.remove();
    }
  }

  app.guildRosterDecorations = Object.freeze({
    normalizedText,
    isGuildRosterTable,
    isInvitedRow,
    leafTextCandidates,
    playerForCell,
    inviteStartedAt,
    formatElapsedHours,
    decorate,
    clear
  });
})(globalThis);

// ---- src/ui/import-export-dialog.js ----
(function initImportExportDialog(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const dom = app.dom;

  function showImportDialog(preview, i18n) {
    return new Promise((resolve) => {
      const backdrop = dom.element("div", { className: "mwi-git-dialog-backdrop" });
      const dialog = dom.element("section", {
        className: "mwi-git-dialog",
        attributes: { role: "dialog", "aria-modal": "true", "aria-labelledby": "mwi-git-import-title" }
      });
      const title = dom.element("h2", { text: i18n.t("importPreview"), attributes: { id: "mwi-git-import-title" } });
      const grid = dom.element("div", { className: "mwi-git-preview" });
      const fields = [
        [i18n.t("sourceCharacter"), `${preview.source.characterName}（#${preview.source.characterId ?? "?"}）`],
        [i18n.t("sourceSite"), preview.source.hostname],
        [i18n.t("exportedAt"), dom.formatDate(preview.exportedAt, i18n.language)],
        [i18n.t("players"), `${preview.counts.players}（${i18n.duplicateCount(preview.duplicates.players)}）`],
        [i18n.t("observations"), `${preview.counts.profileObservations}（${i18n.duplicateCount(preview.duplicates.profileObservations)}）`],
        [i18n.t("invites"), `${preview.counts.inviteEvents}（${i18n.duplicateCount(preview.duplicates.inviteEvents)}）`]
      ];
      for (const [label, value] of fields) {
        grid.append(dom.element("span", { text: label }), dom.element("strong", { text: value }));
      }
      const warning = preview.crossIdentity
        ? dom.element("p", { className: "mwi-git-warning", text: i18n.t("importWarning") })
        : null;
      const select = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("importTitle") } });
      for (const [value, key] of [["merge", "merge"], ["add", "addOnly"], ["replace", "replace"]]) {
        select.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
      }
      const actions = dom.element("div", { className: "mwi-git-dialog-actions" });
      const cancel = dom.element("button", { className: "mwi-git-button", text: i18n.t("cancel"), type: "button" });
      const confirm = dom.element("button", { className: "mwi-git-button", text: i18n.t("confirmImport"), type: "button" });
      function finish(value) {
        backdrop.remove();
        resolve(value);
      }
      cancel.addEventListener("click", () => finish(null));
      confirm.addEventListener("click", () => {
        if (select.value === "replace" && !root.confirm(`${i18n.t("replace")}: ${i18n.t("confirmClear")}`)) return;
        finish(select.value);
      });
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) finish(null);
      });
      backdrop.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(null);
      });
      actions.append(cancel, confirm);
      dialog.append(title, grid);
      if (warning) dialog.append(warning);
      dialog.append(select, actions);
      backdrop.append(dialog);
      root.document.body.append(backdrop);
      select.focus();
    });
  }

  app.importExportDialog = Object.freeze({ showImportDialog });
})(globalThis);

// ---- src/ui/invite-history-view.js ----
(function initHistoryView(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const dom = app.dom;

  function latestInviteMap(invites) {
    const result = new Map();
    for (const event of invites || []) {
      const previous = result.get(event.playerKey);
      const currentTime = Date.parse(event.attemptedAt || event.detectedAt || 0);
      const previousTime = Date.parse(previous?.attemptedAt || previous?.detectedAt || 0);
      if (!previous || currentTime >= previousTime) result.set(event.playerKey, event);
    }
    return result;
  }

  function latestObservationMap(observations) {
    const result = new Map();
    for (const event of observations || []) {
      const previous = result.get(event.playerKey);
      if (!previous || Date.parse(event.viewedAt || 0) >= Date.parse(previous.viewedAt || 0)) {
        result.set(event.playerKey, event);
      }
    }
    return result;
  }

  function guildLabel(player, i18n) {
    if (player.latestGuild?.state === "joined") {
      return [player.latestGuild.guildName, i18n.guildRole(player.latestGuild.guildRole)].filter(Boolean).join(" · ") || i18n.t("hasGuild");
    }
    if (player.latestGuild?.state === "none") {
      return `${i18n.t("guildNone")} · ${dom.formatDate(player.latestGuild.observedAt, i18n.language)}`;
    }
    return i18n.t("guildUnknown");
  }

  function virtualWindow(total, scrollTop, viewportHeight, rowHeight = 49, overscan = 8) {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeRowHeight = Math.max(1, Number(rowHeight) || 49);
    const safeOverscan = Math.max(0, Number(overscan) || 0);
    const firstVisible = Math.max(0, Math.floor((Number(scrollTop) || 0) / safeRowHeight));
    const visibleCount = Math.max(1, Math.ceil((Number(viewportHeight) || safeRowHeight) / safeRowHeight));
    const start = Math.max(0, firstVisible - safeOverscan);
    const end = Math.min(safeTotal, firstVisible + visibleCount + safeOverscan);
    return { start, end, top: start * safeRowHeight, bottom: Math.max(0, (safeTotal - end) * safeRowHeight) };
  }

  function spacer(height) {
    const node = dom.element("div", { className: "mwi-git-player-spacer", attributes: { "aria-hidden": "true" } });
    node.style.height = `${Math.max(0, height)}px`;
    return node;
  }

  function renderPlayerList(container, data, options, selectedKey, i18n, onSelect, view = {}) {
    dom.clear(container);
    const index = view.dataIndex || core.dataIndex(data);
    const invites = index.invites;
    const observations = index.observations;
    const players = view.players || core.filterPlayers(
      data.players,
      options,
      data.inviteEvents,
      data.profileObservations,
      data.leaderboardEntries,
      index
    );
    if (!players.length) {
      container.append(dom.element("div", { className: "mwi-git-empty", text: i18n.t("emptyPlayers") }));
      return players;
    }
    const start = Math.max(0, Math.min(players.length, Number(view.start) || 0));
    const end = Math.max(start, Math.min(players.length, Number.isFinite(view.end) ? Number(view.end) : players.length));
    const rowHeight = Math.max(1, Number(view.rowHeight) || 49);
    if (start > 0) container.append(spacer(start * rowHeight));
    for (const player of players.slice(start, end)) {
      const invite = invites.get(player.playerKey);
      const activityState = core.activityStateForObservation(observations.get(player.playerKey));
      const status = core.playerStatus(player, invite);
      const assessment = core.engagementAssessment(
        player,
        index.observationLists.get(player.playerKey),
        data.leaderboardEntries,
        Date.now(),
        { dataIndex: index }
      );
      const button = dom.element("button", {
        className: "mwi-git-player",
        type: "button",
        attributes: {
          "aria-selected": String(player.playerKey === selectedKey),
          "data-status": status,
          "data-activity-state": activityState,
          "data-engagement-state": assessment.state
        }
      });
      const dot = dom.element("span", { className: "mwi-git-player-dot", attributes: { "aria-hidden": "true" } });
      const copy = dom.element("span", { className: "mwi-git-player-copy" });
      copy.append(
        dom.element("span", { className: "mwi-git-player-name", text: player.currentName }),
        dom.element("span", {
          className: "mwi-git-player-meta",
          text: player.latestGuild?.state === "none"
            ? `${guildLabel(player, i18n)} · ${i18n.engagementState(assessment.state)}`
            : guildLabel(player, i18n)
        })
      );
      const time = dom.element("span", {
        className: "mwi-git-player-time",
        text: dom.formatDate(player.lastViewedAt || player.lastLeaderboardSeenAt || player.lastInvitedAt, i18n.language, { year: undefined })
      });
      button.append(dot, copy, time);
      button.addEventListener("click", () => onSelect(player.playerKey));
      container.append(button);
    }
    if (end < players.length) container.append(spacer((players.length - end) * rowHeight));
    return players;
  }

  function observationDetail(event, i18n) {
    const details = [];
    if (event.leaderboard) {
      details.push([i18n.leaderboardType(event.leaderboard.typeHrid), i18n.category(event.leaderboard.categoryHrid)].filter(Boolean).join(" · "));
      details.push(`${i18n.t("rank")} ${event.leaderboard.rank ?? "—"}`);
    }
    const guild = event.guildSnapshot;
    details.push(guild?.state === "joined" ? [guild.guildName, i18n.guildRole(guild.guildRole)].filter(Boolean).join(" · ") : i18n.t("guildNone"));
    details.push(i18n.activityState(core.activityStateForObservation(event)));
    return details.filter(Boolean).join(" · ");
  }

  function renderTimeline(container, player, data, i18n, onDelete, existingIndex = null) {
    dom.clear(container);
    if (!player) {
      container.append(dom.element("div", { className: "mwi-git-empty", text: i18n.t("emptyTimeline") }));
      return;
    }
    const head = dom.element("div", { className: "mwi-git-detail-head" });
    const title = dom.element("div");
    const index = existingIndex || core.dataIndex(data);
    const assessment = core.engagementAssessment(
      player,
      index.observationLists.get(player.playerKey),
      data.leaderboardEntries,
      Date.now(),
      { dataIndex: index }
    );
    title.append(
      dom.element("h3", { text: player.currentName }),
      dom.element("div", {
        className: "mwi-git-detail-guild",
        text: player.latestGuild?.state === "none"
          ? `${guildLabel(player, i18n)} · ${i18n.engagementState(assessment.state)}`
          : guildLabel(player, i18n)
      })
    );
    const remove = dom.element("button", {
      className: "mwi-git-button mwi-git-button--danger",
      text: i18n.t("deletePlayer"),
      type: "button"
    });
    remove.addEventListener("click", onDelete);
    head.append(title, remove);
    const profileEvents = data.profileObservations
      .filter((event) => event.playerKey === player.playerKey)
      .sort((a, b) => Date.parse(a.viewedAt || 0) - Date.parse(b.viewedAt || 0));
    const observationsWithEvidence = profileEvents.map((event, index) => ({
      ...event,
      changeEvidence: index > 0 ? core.profileEvidenceBetween(profileEvents[index - 1], event).evidence : [],
      timelineType: "observation",
      timelineAt: event.viewedAt
    }));
    const events = [
      ...observationsWithEvidence,
      ...data.inviteEvents
        .filter((event) => event.playerKey === player.playerKey)
        .map((event) => ({ ...event, timelineType: "invite", timelineAt: event.attemptedAt || event.detectedAt })),
      ...(data.leaderboardEntries || [])
        .filter((event) => event.playerKey === player.playerKey)
        .map((event) => ({ ...event, timelineType: "leaderboard", timelineAt: event.capturedAt }))
    ].sort((a, b) => Date.parse(b.timelineAt || 0) - Date.parse(a.timelineAt || 0));
    const list = dom.element("ol", { className: "mwi-git-timeline" });
    for (const event of events) {
      const invite = event.timelineType === "invite";
      const leaderboard = event.timelineType === "leaderboard";
      const item = dom.element("li", { className: `mwi-git-event${invite ? " mwi-git-event--invite" : ""}` });
      const eventTitle = dom.element("div", { className: "mwi-git-event-title" });
      eventTitle.append(
        dom.element("span", { text: invite ? i18n.t("inviteAttempt") : leaderboard ? i18n.t("leaderboardCaptured") : i18n.t("viewed") }),
        dom.element("time", { className: "mwi-git-event-time", text: dom.formatDate(event.timelineAt, i18n.language) })
      );
      const detail = invite
        ? `${i18n.t("outcome")}：${i18n.t(event.outcome)}`
        : leaderboard
          ? `${i18n.category(event.categoryHrid)} · ${i18n.t("rank")} ${event.rank ?? "—"} · ${event.value1 ?? "—"}`
          : [observationDetail(event, i18n), event.changeEvidence?.length ? i18n.evidence(event.changeEvidence[0]) : ""].filter(Boolean).join(" · ");
      item.append(eventTitle, dom.element("div", { className: "mwi-git-event-detail", text: detail }));
      list.append(item);
    }
    if (!events.length) list.append(dom.element("li", { className: "mwi-git-empty", text: i18n.t("emptyTimeline") }));
    container.append(head, list);
  }

  app.historyView = Object.freeze({ latestInviteMap, latestObservationMap, guildLabel, virtualWindow, renderPlayerList, renderTimeline });
})(globalThis);

// ---- src/ui/panel-shell.js ----
(function initPanelShell(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const dom = app.dom;

  function createPanel(controller, i18n, initialView = {}) {
    let data = { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] };
    let selectedKey = initialView.selectedKey || null;
    let identity = null;
    let settingsOpen = Boolean(initialView.settingsOpen);
    let displayPreferences = app.displayPreferences.normalize(initialView.displayPreferences);
    const settings = {
      query: initialView.query || "",
      guildState: initialView.guildState || "all",
      activityState: initialView.activityState || "all",
      engagementState: initialView.engagementState || "all",
      category: initialView.category || "all",
      inviteOutcome: initialView.inviteOutcome || "all",
      days: initialView.days || "all",
      sort: initialView.sort || "lastViewedAt",
      direction: initialView.direction === "asc" ? "asc" : "desc"
    };
    const initialCollapsed = initialView.collapsed || {};
    const collapsed = {
      filters: Object.hasOwn(initialCollapsed, "filters") ? Boolean(initialCollapsed.filters) : true,
      actions: Object.hasOwn(initialCollapsed, "actions") ? Boolean(initialCollapsed.actions) : true,
      players: Boolean(initialCollapsed.players),
      timeline: Boolean(initialCollapsed.timeline)
    };
    const playerRowHeight = 49;
    const playerOverscan = 8;
    let currentIndex = null;
    let visiblePlayers = [];
    let playersDirty = true;
    let timelineDirty = true;
    let renderPending = true;
    let scrollFrame = null;

    app.styles.installStyles();
    const launcher = dom.element("button", {
      className: "",
      text: i18n.t("launcher"),
      type: "button",
      attributes: { id: "mwi-git-launcher", "aria-haspopup": "dialog", "aria-expanded": "false", hidden: "" }
    });
    const backdrop = dom.element("div", { className: "mwi-git-backdrop", attributes: { hidden: "" } });
    const panel = dom.element("section", {
      className: "mwi-git-panel",
      attributes: { role: "dialog", "aria-modal": "true", "aria-labelledby": "mwi-git-title" }
    });
    const shell = dom.element("div", { className: "mwi-git-shell" });
    let nativeMode = false;
    let nativeHideHandler = null;

    function isOpen() {
      return nativeMode ? !panel.hidden : !backdrop.hidden;
    }

    const header = dom.element("header", { className: "mwi-git-header" });
    const titleBlock = dom.element("div", { className: "mwi-git-title-block" });
    const title = dom.element("h2", { className: "mwi-git-title", text: i18n.t("title"), attributes: { id: "mwi-git-title" } });
    const headerMeta = dom.element("div", { className: "mwi-git-header-meta" });
    const local = dom.element("span", { className: "mwi-git-local", text: i18n.t("localOnly") });
    const identityLabel = dom.element("span", { className: "mwi-git-identity", text: i18n.t("waitIdentity") });
    const summary = dom.element("span", { className: "mwi-git-summary" });
    headerMeta.append(local, identityLabel, summary);
    titleBlock.append(title, headerMeta);
    const settingsButton = dom.element("button", {
      className: "mwi-git-button mwi-git-settings-button",
      text: i18n.t("settings"),
      type: "button",
      attributes: { "aria-controls": "mwi-git-display-settings", "aria-expanded": String(settingsOpen) }
    });
    const close = dom.element("button", { className: "mwi-git-icon-button mwi-git-close-button", text: "×", type: "button", title: i18n.t("close"), attributes: { "aria-label": i18n.t("close") } });
    header.append(titleBlock, local, settingsButton, close);

    const displaySettings = dom.element("section", {
      className: "mwi-git-display-settings",
      attributes: { id: "mwi-git-display-settings", "aria-label": i18n.t("indicatorLocations") }
    });
    const settingsTitle = dom.element("h3", { text: i18n.t("indicatorLocations") });

    function displaySwitch(key, labelKey) {
      const input = dom.element("input", {
        className: "mwi-git-switch",
        type: "checkbox",
        attributes: { role: "switch", "data-display-location": key }
      });
      input.checked = displayPreferences[key];
      const label = dom.element("label", { className: "mwi-git-switch-row" });
      label.append(dom.element("span", { text: i18n.t(labelKey) }), input);
      input.addEventListener("change", () => {
        displayPreferences = controller.setDisplayPreferences({
          ...displayPreferences,
          [key]: input.checked
        });
      });
      return label;
    }

    displaySettings.append(
      settingsTitle,
      displaySwitch("leaderboard", "showOnLeaderboards"),
      displaySwitch("chat", "showInChat")
    );
    displaySettings.hidden = !settingsOpen;
    settingsButton.addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      displaySettings.hidden = !settingsOpen;
      settingsButton.setAttribute("aria-expanded", String(settingsOpen));
    });

    const toolbar = dom.element("div", { className: "mwi-git-toolbar" });
    const search = dom.element("input", { className: "mwi-git-input", type: "search", attributes: { placeholder: i18n.t("search"), "aria-label": i18n.t("search") } });
    const guildState = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allGuildStates") } });
    for (const [value, key] of [["all", "allGuildStates"], ["none", "noGuild"], ["joined", "hasGuild"], ["unknown", "unknown"]]) {
      guildState.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    const activityState = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allActivityStates") } });
    for (const [value, key] of [["all", "allActivityStates"], ["work", "activityWork"], ["offline", "activityOffline"], ["none", "activityNone"], ["unrecorded", "activityUnrecorded"]]) {
      activityState.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    const engagementState = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allEngagementStates") } });
    for (const [value, key] of [["all", "allEngagementStates"], ["online", "engagementOnline"], ["offline", "engagementOffline"]]) {
      engagementState.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    const category = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allCategories") } });
    const inviteOutcome = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allInviteOutcomes") } });
    inviteOutcome.append(dom.element("option", { text: i18n.t("allInviteOutcomes"), attributes: { value: "all" } }));
    for (const value of ["pending", "sent", "already_in_guild", "already_invited", "guild_full", "mode_mismatch", "not_found", "blocked", "rate_limited", "timeout", "ambiguous", "unknown_error"]) {
      inviteOutcome.append(dom.element("option", { text: i18n.t(value), attributes: { value } }));
    }
    const days = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allTime") } });
    for (const [value, key] of [["all", "allTime"], ["7", "last7Days"], ["30", "last30Days"], ["90", "last90Days"]]) {
      days.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    const sort = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("sortRecentView") } });
    for (const [value, key] of [["lastViewedAt", "sortRecentView"], ["lastInvitedAt", "sortRecentInvite"], ["rank", "sortRank"], ["name", "sortName"]]) {
      sort.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    search.value = settings.query;
    guildState.value = settings.guildState;
    activityState.value = settings.activityState;
    engagementState.value = settings.engagementState;
    inviteOutcome.value = settings.inviteOutcome;
    days.value = settings.days;
    sort.value = settings.sort;
    toolbar.append(search, guildState, activityState, engagementState, category, inviteOutcome, days, sort);

    const actions = dom.element("div", { className: "mwi-git-actions" });
    const exportJson = dom.element("button", { className: "mwi-git-button", text: i18n.t("exportJson"), type: "button" });
    const exportCsv = dom.element("button", { className: "mwi-git-button", text: i18n.t("exportCsv"), type: "button" });
    const importJson = dom.element("button", { className: "mwi-git-button", text: i18n.t("importJson"), type: "button" });
    const clear = dom.element("button", { className: "mwi-git-button mwi-git-button--danger", text: i18n.t("clear"), type: "button" });
    const file = dom.element("input", { type: "file", attributes: { accept: "application/json,.json", hidden: "" } });
    actions.append(exportJson, exportCsv, importJson, clear, file);

    const filterSection = dom.element("section", { className: "mwi-git-collapsible" });
    const actionSection = dom.element("section", { className: "mwi-git-collapsible" });
    const body = dom.element("div", { className: "mwi-git-body" });
    const listPane = dom.element("section", { className: "mwi-git-list-pane", attributes: { "aria-label": i18n.t("players") } });
    const list = dom.element("div");
    const detailPane = dom.element("section", { className: "mwi-git-detail-pane", attributes: { "aria-label": i18n.t("timeline") } });
    const detailContent = dom.element("div", { className: "mwi-git-detail-content" });

    function createSectionToggle(sectionKey, labelKey, content) {
      const label = i18n.t(labelKey);
      const labelNode = dom.element("span", { text: label });
      const chevron = dom.element("span", { className: "mwi-git-section-chevron", attributes: { "aria-hidden": "true" } });
      const toggle = dom.element("button", { className: "mwi-git-section-toggle", type: "button" });
      toggle.append(labelNode, chevron);

      function applyState() {
        const isCollapsed = collapsed[sectionKey];
        toggle.setAttribute("aria-expanded", String(!isCollapsed));
        toggle.setAttribute("aria-label", `${i18n.t(isCollapsed ? "expandSection" : "collapseSection")}：${label}`);
        content.hidden = isCollapsed;
        toggle.parentElement.dataset.collapsed = String(isCollapsed);
        body.dataset.playersCollapsed = String(collapsed.players);
        body.dataset.timelineCollapsed = String(collapsed.timeline);
      }

      toggle.addEventListener("click", () => {
        collapsed[sectionKey] = !collapsed[sectionKey];
        applyState();
        if (sectionKey === "players") {
          if (collapsed.players) dom.clear(list);
          else renderPlayers();
        }
        if (sectionKey === "timeline") {
          if (collapsed.timeline) dom.clear(detailContent);
          else renderTimeline();
        }
      });
      root.queueMicrotask(applyState);
      return toggle;
    }

    filterSection.append(createSectionToggle("filters", "filtersSection", toolbar), toolbar);
    actionSection.append(createSectionToggle("actions", "dataSection", actions), actions);
    listPane.append(createSectionToggle("players", "players", list), list);
    detailPane.append(createSectionToggle("timeline", "timeline", detailContent), detailContent);
    body.append(listPane, detailPane);
    shell.append(header, displaySettings, filterSection, actionSection, body);
    panel.append(shell);
    backdrop.append(panel);

    function toast(message) {
      const node = dom.element("div", { className: "mwi-git-toast", text: message, attributes: { role: "status" } });
      root.document.body.append(node);
      root.setTimeout(() => node.remove(), 3500);
    }

    function selectedPlayer() {
      return data.players.find((player) => player.playerKey === selectedKey) || null;
    }

    function renderMetadata() {
      summary.textContent = i18n.summary({
        players: data.players.length,
        observations: data.profileObservations.length,
        invites: data.inviteEvents.length,
        leaderboardCaptures: (data.leaderboardCaptures || []).length
      });
      identityLabel.textContent = identity
        ? identity.characterName
        : i18n.t("waitIdentity");
    }

    function renderCategories() {
      const categories = [...new Set([
        ...data.profileObservations.map((event) => event.leaderboard?.categoryHrid),
        ...(data.leaderboardEntries || []).map((event) => event.categoryHrid)
      ].filter(Boolean))].sort();
      const previousCategory = settings.category;
      category.replaceChildren(dom.element("option", { text: i18n.t("allCategories"), attributes: { value: "all" } }));
      for (const value of categories) category.append(dom.element("option", { text: i18n.category(value), attributes: { value } }));
      settings.category = categories.includes(previousCategory) ? previousCategory : "all";
      category.value = settings.category;
    }

    function renderPlayers(options = {}) {
      if (!isOpen() || collapsed.players) {
        playersDirty = true;
        return;
      }
      currentIndex = currentIndex || app.core.dataIndex(data);
      if (playersDirty || options.refilter) {
        visiblePlayers = app.core.filterPlayers(
          data.players,
          settings,
          data.inviteEvents,
          data.profileObservations,
          data.leaderboardEntries,
          currentIndex
        );
        playersDirty = false;
        if (options.resetScroll) listPane.scrollTop = 0;
      }
      if (selectedKey && !data.players.some((player) => player.playerKey === selectedKey)) selectedKey = null;
      if (!selectedKey && visiblePlayers.length) {
        selectedKey = visiblePlayers[0].playerKey;
        timelineDirty = true;
      }
      const window = app.historyView.virtualWindow(
        visiblePlayers.length,
        Math.max(0, listPane.scrollTop - 27),
        listPane.clientHeight || 600,
        playerRowHeight,
        playerOverscan
      );
      app.historyView.renderPlayerList(list, data, settings, selectedKey, i18n, (key) => {
        selectedKey = key;
        timelineDirty = true;
        renderPlayers();
        renderTimeline();
      }, {
        players: visiblePlayers,
        dataIndex: currentIndex,
        rowHeight: playerRowHeight,
        ...window
      });
    }

    function renderTimeline() {
      if (!isOpen() || collapsed.timeline) {
        timelineDirty = true;
        return;
      }
      currentIndex = currentIndex || app.core.dataIndex(data);
      app.historyView.renderTimeline(detailContent, selectedPlayer(), data, i18n, async () => {
        if (!root.confirm(i18n.t("confirmDelete"))) return;
        await controller.deletePlayer(selectedKey);
        selectedKey = null;
        await controller.refresh();
      }, currentIndex);
      timelineDirty = false;
    }

    function render() {
      renderMetadata();
      if (!isOpen()) {
        renderPending = true;
        return;
      }
      renderPending = false;
      renderCategories();
      renderPlayers({ refilter: playersDirty });
      if (timelineDirty) renderTimeline();
    }

    function open() {
      if (nativeMode) panel.hidden = false;
      else backdrop.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
      render();
      controller.refresh();
      search.focus();
    }
    function hide() {
      if (nativeMode) panel.hidden = true;
      else backdrop.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      if (!nativeMode && !launcher.hidden) launcher.focus();
    }
    function requestHide() {
      if (nativeMode && nativeHideHandler) nativeHideHandler();
      else hide();
    }
    launcher.addEventListener("click", open);
    close.addEventListener("click", requestHide);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) requestHide(); });
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") requestHide(); });
    function renderAfterFilterChange() {
      playersDirty = true;
      renderPlayers({ refilter: true, resetScroll: true });
    }
    search.addEventListener("input", () => { settings.query = search.value; renderAfterFilterChange(); });
    guildState.addEventListener("change", () => { settings.guildState = guildState.value; renderAfterFilterChange(); });
    activityState.addEventListener("change", () => { settings.activityState = activityState.value; renderAfterFilterChange(); });
    engagementState.addEventListener("change", () => { settings.engagementState = engagementState.value; renderAfterFilterChange(); });
    category.addEventListener("change", () => { settings.category = category.value; renderAfterFilterChange(); });
    inviteOutcome.addEventListener("change", () => { settings.inviteOutcome = inviteOutcome.value; renderAfterFilterChange(); });
    days.addEventListener("change", () => { settings.days = days.value; renderAfterFilterChange(); });
    sort.addEventListener("change", () => {
      settings.sort = sort.value;
      settings.direction = sort.value === "name" || sort.value === "rank" ? "asc" : "desc";
      renderAfterFilterChange();
    });
    listPane.addEventListener("scroll", () => {
      if (!isOpen() || collapsed.players || scrollFrame !== null) return;
      const schedule = typeof root.requestAnimationFrame === "function"
        ? root.requestAnimationFrame.bind(root)
        : (callback) => root.setTimeout(callback, 0);
      scrollFrame = schedule(() => {
        scrollFrame = null;
        renderPlayers();
      });
    });
    exportJson.addEventListener("click", () => controller.exportJson());
    exportCsv.addEventListener("click", () => controller.exportCsv());
    importJson.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      file.value = "";
      if (!selected) return;
      try {
        if (selected.size > app.config.maxImportBytes) throw new Error("backup_too_large");
        const prepared = await controller.prepareImport(await selected.text());
        const strategy = await app.importExportDialog.showImportDialog(prepared.preview, i18n);
        if (!strategy) return;
        const report = await controller.applyImport(prepared.backup, strategy);
        toast(`${i18n.t("importSuccess")} · +${report.addedPlayers || 0} ${i18n.t("players")}`);
        await controller.refresh();
      } catch (error) {
        console.error("[MWI Guild Invite Tracker] Import failed", error);
        toast(i18n.t("importFailed"));
      }
    });
    clear.addEventListener("click", async () => {
      if (!root.confirm(i18n.t("confirmClear"))) return;
      await controller.clear();
      selectedKey = null;
      await controller.refresh();
    });
    function mount() {
      root.document.body.append(launcher, backdrop);
      renderMetadata();
    }
    function mountNative(host, onRequestHide) {
      nativeMode = true;
      nativeHideHandler = typeof onRequestHide === "function" ? onRequestHide : null;
      close.remove();
      launcher.hidden = true;
      backdrop.hidden = true;
      panel.hidden = true;
      panel.classList.add("mwi-git-panel--native");
      panel.setAttribute("role", "region");
      panel.removeAttribute("aria-modal");
      host.append(panel);
    }
    function restoreOverlay() {
      if (!nativeMode) return;
      nativeMode = false;
      nativeHideHandler = null;
      header.append(close);
      panel.hidden = false;
      panel.classList.remove("mwi-git-panel--native");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      backdrop.append(panel);
      backdrop.hidden = true;
    }
    function enableFallback() {
      if (!nativeMode) launcher.hidden = false;
    }
    function disableFallback() {
      launcher.hidden = true;
    }
    function setData(next) {
      data = next || { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] };
      currentIndex = null;
      playersDirty = true;
      timelineDirty = true;
      renderMetadata();
      if (isOpen()) render();
      else renderPending = true;
    }
    function setIdentity(next) {
      identity = next;
      renderMetadata();
    }
    function destroy() {
      launcher.remove();
      backdrop.remove();
      panel.remove();
    }

    function viewState() {
      return {
        ...settings,
        selectedKey,
        settingsOpen,
        displayPreferences: { ...displayPreferences },
        collapsed: { ...collapsed },
        open: isOpen(),
        renderPending
      };
    }

    return {
      mount,
      mountNative,
      restoreOverlay,
      enableFallback,
      disableFallback,
      open,
      openNative: open,
      hide,
      hideNative: hide,
      isNativeMounted: () => nativeMode && panel.isConnected,
      element: panel,
      setData,
      setIdentity,
      render,
      toast,
      destroy,
      viewState
    };
  }

  app.panelShell = Object.freeze({ createPanel });
})(globalThis);

// ---- src/userscript.js ----
(function startUserscript(root) {
  "use strict";

  const app = root.MWIGuildInviteTracker;
  if (!app || root.__MWIGuildInviteTrackerStarted) return;
  Object.defineProperty(root, "__MWIGuildInviteTrackerStarted", { value: true });

  const repository = app.storage.createRepository();
  const tracker = app.contextTracker.createContextTracker();
  let identity = null;
  let namespace = null;
  let panel = null;
  let sidebar = null;
  let currentData = { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] };
  let observer = null;
  let protocolChain = Promise.resolve();
  const queuedActions = [];
  const i18n = app.localization.createI18n();
  const preferenceStore = app.displayPreferences.createStore(root.localStorage, app.config.settingsKey);
  let displayPreferences = preferenceStore.load();
  const decorationScheduler = app.scheduler.frameScheduler(() => {
    app.leaderboardDecorations.decorate(currentData, i18n, identity, displayPreferences.leaderboard);
    app.chatDecorations.decorate(currentData, i18n, identity, displayPreferences.chat);
    app.guildRosterDecorations.decorate(currentData, i18n);
  });

  async function refresh() {
    if (!namespace) {
      currentData = { players: [], profileObservations: [], inviteEvents: [], leaderboardCaptures: [], leaderboardEntries: [] };
    } else {
      currentData = await repository.snapshot(namespace);
    }
    panel?.setData(currentData);
    decorationScheduler.request();
    return currentData;
  }

  async function handleDetectedInvite(action) {
    if (!namespace || !action.character?.name) return;
    const normalized = app.core.normalizeName(action.character.name);
    const exists = currentData.inviteEvents.some(
      (event) => event.normalizedName === normalized && event.outcome === "sent"
    );
    if (exists) return;
    const detectedAt = action.detectedAt;
    const player = {
      ...app.core.playerFromInvite(action.character.name, detectedAt),
      characterId: app.core.nullableNumber(action.character.characterId),
      playerKey: app.core.playerKey(action.character.characterId, action.character.name)
    };
    const invite = {
      ...app.core.makeInviteEvent(action.character.name, detectedAt, identity, null),
      id: `detected:${identity?.guildId || "guild"}:${action.character.characterId || normalized}`,
      playerKey: player.playerKey,
      attemptedAt: null,
      confirmedAt: null,
      detectedAt,
      outcome: "sent",
      correlation: "guild_characters_updated"
    };
    await repository.recordInvite(namespace, player, invite);
  }

  async function processAction(action) {
    if (action.type === "identity") {
      identity = action.identity;
      namespace = repository.namespaceFor(identity);
      panel?.setIdentity(identity);
      try {
        root.localStorage.setItem(app.config.lastIdentityKey, JSON.stringify(identity));
      } catch (_error) {
        // Identity persistence is only a diagnostic convenience.
      }
      const waiting = queuedActions.splice(0);
      for (const queued of waiting) await processAction(queued);
      await refresh();
      return;
    }
    if (action.type === "leaderboard") {
      decorationScheduler.request();
      return;
    }
    if (!namespace) {
      if (queuedActions.length < 100 && !["profile_timeout"].includes(action.type)) queuedActions.push(action);
      return;
    }
    if (action.type === "record_observation") {
      await repository.recordObservation(namespace, action.player, action.observation);
      await refresh();
      return;
    }
    if (action.type === "record_leaderboard") {
      await repository.recordLeaderboard(namespace, action.players, action.capture, action.entries);
      await refresh();
      return;
    }
    if (action.type === "sync_guild_members") {
      const players = action.characters
        .map((character) => app.core.playerFromGuildMember(character, action.identity, action.observedAt))
        .filter((player) => player.currentName);
      await repository.upsertPlayers(namespace, players);
      await refresh();
      return;
    }
    if (action.type === "record_invite") {
      await repository.recordInvite(namespace, action.player, action.invite);
      await refresh();
      return;
    }
    if (action.type === "update_invite") {
      await repository.updateInvite(namespace, action.invite);
      await refresh();
      return;
    }
    if (action.type === "detected_invite") {
      await handleDetectedInvite(action);
      await refresh();
    }
  }

  function handleBridge(event) {
    const domainEvent = app.gameProtocol.toDomainEvent(event.detail);
    if (!domainEvent) return;
    const actions = tracker.consume(domainEvent);
    protocolChain = protocolChain
      .then(async () => {
        for (const action of actions) await processAction(action);
      })
      .catch((error) => console.error("[MWI Guild Invite Tracker] Failed to process game event", error));
  }

  root.addEventListener(app.config.bridgeEvent, handleBridge);
  app.bridge.inject();

  function syncGameLanguage() {
    const nextLanguage = app.localization.detectLanguage();
    if (nextLanguage === i18n.language) return false;
    const viewState = panel?.viewState() || {};
    i18n.setLanguage(nextLanguage);
    if (!panel) return true;
    sidebar?.destroy();
    sidebar = null;
    panel.destroy();
    panel = app.panelShell.createPanel(controller, i18n, viewState);
    panel.mount();
    panel.setIdentity(identity);
    panel.setData(currentData);
    sidebar = app.sidebarIntegration.createController({ panel, i18n });
    sidebar.start();
    if (viewState.open) sidebar.open();
    decorationScheduler.request();
    return true;
  }

  const controller = {
    refresh,
    setDisplayPreferences(next) {
      displayPreferences = preferenceStore.save(next);
      decorationScheduler.request();
      return { ...displayPreferences };
    },
    async exportJson() {
      if (!identity || !namespace) return panel?.toast(i18n.t("waitIdentity"));
      const backup = await app.importExport.createBackup(await repository.snapshot(namespace), identity);
      app.importExport.downloadText(
        `${JSON.stringify(backup, null, 2)}\n`,
        app.importExport.backupFilename(identity)
      );
    },
    async exportCsv() {
      if (!identity || !namespace) return panel?.toast(i18n.t("waitIdentity"));
      const data = await repository.snapshot(namespace);
      const exports = app.importExport.createCsvExports(data);
      const base = app.importExport.backupFilename(identity, "csv").replace(/\.csv$/, "");
      app.importExport.downloadText(exports.players, `${base}-players.csv`, "text/csv;charset=utf-8");
      root.setTimeout(() => app.importExport.downloadText(exports.profileObservations, `${base}-profile-observations.csv`, "text/csv;charset=utf-8"), 100);
      root.setTimeout(() => app.importExport.downloadText(exports.inviteEvents, `${base}-invite-events.csv`, "text/csv;charset=utf-8"), 200);
      root.setTimeout(() => app.importExport.downloadText(exports.leaderboardCaptures, `${base}-leaderboard-captures.csv`, "text/csv;charset=utf-8"), 300);
      root.setTimeout(() => app.importExport.downloadText(exports.leaderboardEntries, `${base}-leaderboard-entries.csv`, "text/csv;charset=utf-8"), 400);
    },
    async prepareImport(text) {
      if (!identity || !namespace) throw new Error("identity_unavailable");
      const backup = await app.importExport.parseBackupText(text);
      const preview = app.importExport.previewImport(await repository.snapshot(namespace), backup, identity);
      return { backup, preview };
    },
    async applyImport(backup, strategy) {
      if (!identity || !namespace) throw new Error("identity_unavailable");
      const current = await repository.snapshot(namespace);
      if (strategy === "replace") {
        const automaticBackup = await app.importExport.createBackup(current, identity);
        app.importExport.downloadText(
          `${JSON.stringify(automaticBackup, null, 2)}\n`,
          app.importExport.backupFilename(identity).replace(".json", "-before-replace.json")
        );
        await repository.replaceSnapshot(namespace, app.core.structuredCloneSafe(backup.data));
        return {
          addedPlayers: backup.data.players.length,
          addedObservations: backup.data.profileObservations.length,
          addedInvites: backup.data.inviteEvents.length,
          addedLeaderboardCaptures: backup.data.leaderboardCaptures.length,
          addedLeaderboardEntries: backup.data.leaderboardEntries.length,
          replaced: true
        };
      }
      const merged = app.importExport.mergeSnapshots(current, backup.data, strategy);
      await repository.replaceSnapshot(namespace, merged.data);
      return merged.report;
    },
    async clear() {
      if (namespace) await repository.clearNamespace(namespace);
    },
    async deletePlayer(key) {
      if (namespace && key) await repository.deletePlayer(namespace, key);
    }
  };

  function mount() {
    if (!root.document.body || panel) return;
    panel = app.panelShell.createPanel(controller, i18n, { displayPreferences });
    panel.mount();
    panel.setIdentity(identity);
    panel.setData(currentData);
    sidebar = app.sidebarIntegration.createController({ panel, i18n });
    sidebar.start();
    observer = new MutationObserver(() => {
      decorationScheduler.request();
      syncGameLanguage();
    });
    observer.observe(root.document.body, { childList: true, subtree: true });
    decorationScheduler.request();
  }

  if (root.document.body) mount();
  else root.document.addEventListener("DOMContentLoaded", mount, { once: true });

  const expiryTimer = root.setInterval(() => {
    const actions = tracker.expire();
    protocolChain = protocolChain
      .then(async () => {
        for (const action of actions) await processAction(action);
      })
      .catch((error) => console.error("[MWI Guild Invite Tracker] Failed to expire pending events", error));
  }, 1000);
  const languageTimer = root.setInterval(syncGameLanguage, 1000);
  const relativeTimeTimer = root.setInterval(() => decorationScheduler.request(), 60_000);

  app.runtime = Object.freeze({
    controller,
    tracker,
    repository,
    get identity() { return identity; },
    get namespace() { return namespace; },
    async destroy() {
      root.clearInterval(expiryTimer);
      root.clearInterval(languageTimer);
      root.clearInterval(relativeTimeTimer);
      root.removeEventListener(app.config.bridgeEvent, handleBridge);
      observer?.disconnect();
      decorationScheduler.destroy();
      app.leaderboardDecorations.clear();
      app.chatDecorations.clear();
      app.guildRosterDecorations.clear();
      sidebar?.destroy();
      panel?.destroy();
      await repository.close();
    }
  });
})(globalThis);
