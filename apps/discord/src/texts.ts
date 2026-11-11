// What the bot says, in English and German (ADR 0003). German must have every English key, so a
// missing translation fails the type check.
import type { ServerStatus } from '@harrier-gg/contracts';

const en = {
  status: {
    installing: 'installing',
    starting: 'starting',
    running: 'running',
    stopping: 'stopping',
    stopped: 'stopped',
    crashed: 'crashed',
    sleeping: 'sleeping',
  } satisfies Record<ServerStatus, string>,
  port: (port: number) => `port ${port}`,
  noServers: 'There are no servers yet. Create one in the panel.',
  notLinked: 'Link your Discord account in the Harrier panel first (top right, "Discord").',
  notAllowed: 'Your role does not allow that.',
  unknownServer: (name: string) => `There is no server called "${name}".`,
  starting: (user: string, server: string) => `▶️ ${user} starts **${server}** …`,
  waking: (user: string, server: string) => `⏰ ${user} wakes **${server}** up …`,
  stopping: (user: string, server: string) => `⏹️ ${user} stops **${server}** …`,
  alreadyRunning: (server: string) => `**${server}** is already running.`,
  alreadyStopped: (server: string) => `**${server}** is not running.`,
  failed: (detail: string) => `That did not work: ${detail}`,
  online: (server: string, port: number) => `🟢 **${server}** is online (port ${port}).`,
  crashed: (server: string, reason: string) => `🔴 **${server}** crashed: ${reason}`,
};

export type Texts = typeof en;

const de: Texts = {
  status: {
    installing: 'wird installiert',
    starting: 'startet',
    running: 'läuft',
    stopping: 'stoppt',
    stopped: 'gestoppt',
    crashed: 'abgestürzt',
    sleeping: 'schläft',
  },
  port: (port) => `Port ${port}`,
  noServers: 'Es gibt noch keine Server. Leg einen im Panel an.',
  notLinked: 'Verknüpfe zuerst dein Discord-Konto im Harrier-Panel (oben rechts, „Discord“).',
  notAllowed: 'Das darf deine Rolle nicht.',
  unknownServer: (name) => `Es gibt keinen Server namens „${name}“.`,
  starting: (user, server) => `▶️ ${user} startet **${server}** …`,
  waking: (user, server) => `⏰ ${user} weckt **${server}** auf …`,
  stopping: (user, server) => `⏹️ ${user} stoppt **${server}** …`,
  alreadyRunning: (server) => `**${server}** läuft schon.`,
  alreadyStopped: (server) => `**${server}** läuft nicht.`,
  failed: (detail) => `Das hat nicht geklappt: ${detail}`,
  online: (server, port) => `🟢 **${server}** ist online (Port ${port}).`,
  crashed: (server, reason) => `🔴 **${server}** ist abgestürzt: ${reason}`,
};

/** Texts for a Discord locale (`de`, `en-US`, …); English unless it is German. */
export function texts(locale: string | undefined): Texts {
  return locale?.startsWith('de') ? de : en;
}
