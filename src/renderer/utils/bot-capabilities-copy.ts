/**
 * Plain words for a bot's "What it can do" rows. The facts come from the main process
 * (BotCapabilitySummary), which computes them with the checks that enforce each limit; this
 * file only words them, so it must never claim more than a fact says.
 */
import {
  EXPLICIT_CONSENT_LABELS,
  type BotCapabilitySummary,
  type BotServiceCapability,
  type BotServiceUse,
} from "../../shared/bot-capabilities";
import { BOT_DESKTOP_LIMITS } from "../../shared/bot-computer";
import type { ExplicitConsentKind } from "../../shared/explicit-consent";

export type BotCapabilityRowId = "where" | "files" | "services" | "schedules" | "memory" | "ok";

/** A detail line, or a lead-in with its own short list. */
export type BotCapabilityDetail = string | { lead: string; items: string[] };

export interface BotCapabilityRow {
  id: BotCapabilityRowId;
  label: string;
  summary: string;
  details: BotCapabilityDetail[];
  /** The read behind this row failed. */
  unavailable?: boolean;
}

const SERVICES_SHOWN = 3;
const CONSENT_SHOWN = 2;

/** The order reasons are listed in: the ones people meet most often first. */
const CONSENT_ORDER: readonly ExplicitConsentKind[] = [
  "delete",
  "data_export",
  "app_action",
  "external_service",
  "unconfigured_connector",
  "protected_credential",
  "dangerous_shell",
  "location",
  "voice_call",
  "risk_gate",
];

const SERVICE_USE_TEXT: Record<BotServiceUse, string> = {
  yes: "can use",
  chats_you_start_only: "only in chats you start",
  denied_for_bot: "turned off for this bot",
  not_in_computer_mode: "not while its work runs in its computer",
  not_with_works_on: "not with its Works on setting",
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function listWithMore(labels: string[], shown: number): string {
  if (labels.length <= shown) return labels.join(", ");
  return `${labels.slice(0, shown).join(", ")} +${labels.length - shown}`;
}

function whereRow(summary: BotCapabilitySummary): BotCapabilityRow {
  const { worksOn, reach, desktop, computer } = summary.where;
  let text: string;
  switch (worksOn) {
    case "off":
      text = "No computer or browser";
      break;
    case "browser":
      text = "Only the in-app browser";
      break;
    case "own_desktop":
      text = `Its own desktop ${desktop?.host ? `on ${desktop.host}` : "on this Mac"}`;
      if (desktop) text += desktop.network === "off" ? " · no network" : " · internet only";
      break;
    case "this_computer":
      text = "Apps on this Mac and the in-app browser";
      break;
    default:
      text = "This Mac or the in-app browser, as the task needs";
  }
  const reachable = [
    reach.host ? "apps on this Mac" : null,
    reach.browser ? "the in-app browser" : null,
    reach.desktop ? "its own desktop" : null,
  ].filter((entry): entry is string => Boolean(entry));
  const details = [
    reachable.length
      ? `Can use ${reachable.join(", ")}.`
      : "Can't use a computer or browser. Files, commands and services still work.",
  ];
  if (reach.handoff) details.push("Can ask you to take over a step.");
  if (desktop?.group) details.push(`Shares its desktop with bots set to "${desktop.group}".`);
  if (desktop?.network === "off") details.push("Its desktop has no network at all.");
  else if (desktop) {
    details.push("Its desktop reaches the internet, not this Mac or your local network.");
  }
  if (computer) {
    const where = computer.backend === "cua" ? "a Cua Space" : "its Docker or Podman computer";
    const lifetime =
      computer.lifetime === "task" ? "a fresh one for each task" : "kept across its tasks";
    text += " · all work in its computer";
    details.push(`Commands, files and browsing run in ${where}, ${lifetime}.`);
  }
  return { id: "where", label: "Works on", summary: text, details };
}

function filesRow(summary: BotCapabilitySummary): BotCapabilityRow {
  const { onItsOwn } = summary.files;
  if (onItsOwn === "workspace") {
    return {
      id: "files",
      label: "Files",
      summary: "Works in the project it's given, even on its own",
      details: ["Schedules, check-ins and channel messages also use the project they were given."],
    };
  }
  const folder = onItsOwn === "desktop_folder" ? "its desktop's work folder" : "its own folder";
  return {
    id: "files",
    label: "Files",
    summary: `Chats you start use your project. On its own it uses ${folder}.`,
    details: [
      `Schedules, check-ins and channel messages work in ${folder}, with shell commands sandboxed.`,
    ],
  };
}

function serviceDetail(item: BotServiceCapability): string {
  const use = SERVICE_USE_TEXT[item.use];
  const limited = item.limited ? ", some actions turned off" : "";
  const state = item.connected ? "" : " (set up, not connected)";
  return `${item.label}${state}: ${use}${limited}`;
}

function servicesRow(summary: BotCapabilitySummary): BotCapabilityRow {
  const { items, channels } = summary.services;
  const usable = items.filter((item) => item.use === "yes" || item.use === "chats_you_start_only");
  const chatOnly = usable.filter((item) => item.use === "chats_you_start_only").length;
  let text = items.length === 0 ? "No services connected" : "None it can use";
  if (usable.length) {
    text = listWithMore(
      usable.map((item) => item.label),
      SERVICES_SHOWN,
    );
    if (chatOnly) text += ` · ${chatOnly} only in chats you start`;
  }
  const details = items.map(serviceDetail);
  for (const channel of channels) {
    details.push(
      channel.link === "default"
        ? `Messages from ${channel.label} go to this bot.`
        : `${channel.label} can hand messages to this bot.`,
    );
  }
  return {
    id: "services",
    label: "Services",
    summary: text,
    details,
    unavailable: summary.partial.includes("services"),
  };
}

function formatNextRun(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function schedulesRow(summary: BotCapabilitySummary, now: number): BotCapabilityRow {
  const { runtime, scheduled, nextRunAt, responsibilities, checkIns } = summary.schedules;
  const parts: string[] = [];
  if (responsibilities.active)
    parts.push(plural(responsibilities.active, "responsibility", "responsibilities"));
  if (scheduled) parts.push(`${scheduled} scheduled`);
  if (checkIns.enabled) parts.push(`checks in every ${checkIns.everyMinutes ?? 15} min`);
  if (nextRunAt) parts.push(`next run ${formatNextRun(nextRunAt, now)}`);
  const details: string[] = [];
  if (responsibilities.paused) {
    details.push(
      `${plural(responsibilities.paused, "responsibility", "responsibilities")} paused.`,
    );
  }
  if (runtime !== "running") {
    details.push(
      runtime === "disabled"
        ? "Scheduling is turned off, so nothing runs on its own."
        : "The scheduler isn't running, so nothing runs on its own right now.",
    );
  }
  if (checkIns.enabled && checkIns.nextAt) {
    details.push(`Next check-in ${formatNextRun(checkIns.nextAt, now)}.`);
  }
  return {
    id: "schedules",
    label: "Schedules",
    summary: parts.length ? parts.join(" · ") : "Runs only when you ask",
    details,
    unavailable: summary.partial.includes("schedules"),
  };
}

function memoryRow(summary: BotCapabilitySummary, savedOverride?: number): BotCapabilityRow {
  const { available, recallPastChats } = summary.memory;
  const saved = savedOverride ?? summary.memory.saved;
  const recall = recallPastChats ? "recalls its past chats" : "doesn't search past chats";
  return {
    id: "memory",
    label: "Memory",
    summary: !available
      ? "Memory folder unavailable"
      : `${saved ? plural(saved, "saved fact") : "Nothing saved yet"} · ${recall}`,
    details: ["Its memory is its own: other bots and ordinary tasks never read it."],
    unavailable: summary.partial.includes("memory"),
  };
}

function okRow(summary: BotCapabilitySummary): BotCapabilityRow {
  const { mayDoAlone, inChats, needsOk, deniedTools, denyAll } = summary.safeguards;
  const kinds = CONSENT_ORDER.filter((kind) => needsOk.includes(kind));
  const reasons = Array.from(new Set(kinds.map((kind) => EXPLICIT_CONSENT_LABELS[kind])));
  const head =
    inChats === "refuses"
      ? "Never asks: steps that need your OK are refused"
      : `Asks before ${listWithMore(reasons, CONSENT_SHOWN)}`;
  const details: BotCapabilityDetail[] =
    inChats === "refuses"
      ? [{ lead: "Its access never asks, so these are refused:", items: reasons }]
      : [
          { lead: "In chats you start, it asks you first before:", items: reasons },
          "A saved rule or a connector's own setting can allow some of these without asking.",
        ];
  details.push(
    "When it runs on its own (schedules, check-ins, channels), anything that needs your OK is refused. Slack and Teams owners can approve from a decision card.",
    `May do alone: ${mayDoAlone.label}.`,
    "It can't open credential stores in your home folder, such as .ssh and Keychains.",
    "Saved browser passwords are filled in without the model seeing them.",
  );
  if (summary.where.worksOn === "own_desktop") {
    details.push(
      `Its desktop has no admin rights, ${BOT_DESKTOP_LIMITS.memoryGb} GB of memory and ${BOT_DESKTOP_LIMITS.cpus} CPUs, and sees only its own folder.`,
    );
  }
  if (denyAll) details.push("Every tool is turned off for this bot.");
  else if (deniedTools.length) details.push(`Turned off for this bot: ${deniedTools.join(", ")}.`);
  return {
    id: "ok",
    label: "Needs your OK",
    summary: `${head} · May do alone: ${mayDoAlone.id ? mayDoAlone.label : "No limit"}`,
    details,
    unavailable: summary.partial.includes("safeguards"),
  };
}

export function botCapabilityRows(
  summary: BotCapabilitySummary,
  options: { now?: number; memorySaved?: number } = {},
): BotCapabilityRow[] {
  const now = options.now ?? Date.now();
  return [
    whereRow(summary),
    filesRow(summary),
    servicesRow(summary),
    schedulesRow(summary, now),
    memoryRow(summary, options.memorySaved),
    okRow(summary),
  ];
}
