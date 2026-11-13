// Templates (ADR 0005): load YAML files, resolve `extends`, validate settings and build the
// game-neutral runtime spec the agent executes. Everything game-specific stays here.
import type { SettingValue, TemplateConfigField, TemplateSummary } from '@harrier-gg/contracts';
import type { RuntimeSpec } from '@harrier-gg/protocol';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { PROVIDERS } from './versions';

const Localized = z.object({ en: z.string(), de: z.string().optional() });

const ConfigField = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    label: Localized,
    // `version`: one of the versions of the template's version provider (ADR 0012).
    // `modpack`: a Modrinth modpack the image installs; its game version picks the Java (ADR 0020).
    // `boolean`: true or false. `secret`: text like `string` (passwords, tokens).
    type: z.enum(['string', 'integer', 'version', 'modpack', 'boolean', 'secret']),
    default: z
      .union([z.string(), z.number(), z.boolean()])
      .describe('Must fit the field, except "" for a secret: the panel then generates a random value per server.'),
    // `integer`: the value's range; `string` and `secret`: its length.
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    // Where the value goes: an environment variable or a resource limit.
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    // `sleep`: minutes without players before the server sleeps, 0 = never (ADR 0013).
    limit: z.enum(['memory', 'sleep']).optional(),
    // `boolean` only: what goes into `env` for true and false (default "true"/"false"; eggs use "1"/"0").
    values: z.object({ on: z.string(), off: z.string() }).optional(),
  })
  // An empty secret default means "generate one per server", so no template ships a shared password.
  .refine((f) => (f.type === 'secret' && f.default === '') || checkValue(f, f.default) === null, 'The default does not fit the field')
  .refine((f) => !f.values || f.type === 'boolean', '`values` is only for boolean fields');

/** A path inside the server's data directory: names separated by "/"; no name starts with "." (so no ".."). */
const ConfigPath = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/);

/** A kind of content and where to get it (ADR 0017); each source's options belong to its provider. */
const ContentKind = z.object({
  kind: z.string().regex(/^[a-z][a-z-]{0,39}$/),
  label: Localized,
  path: ConfigPath,
  sources: z.array(z.looseObject({ provider: z.string().regex(/^[a-z][a-z-]{0,39}$/) })).min(1),
});

/** How players get the content they need (ADR 0018): a pack format and the loader it names. */
const Share = z.object({ format: z.enum(['mrpack']), loader: z.enum(['fabric-loader']) });

/** Image per Java major version, so a game version gets the Java it needs (ADR 0012). */
const JavaImages = z.record(z.string().regex(/^[0-9]+$/), z.string());

/** An absolute path inside the container, without "." or ".." segments. */
const AbsolutePath = z.string().regex(/^(\/(?!\.\.?(\/|$))[A-Za-z0-9._-]+)+$/);

/**
 * `offset`: host port = the server's first host port + offset (default: the port's index).
 * `samePort`: the container listens on the host port too (games that announce their own port).
 */
const Port = z.object({
  name: z.string(),
  container: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']),
  offset: z.number().int().min(0).optional(),
  samePort: z.boolean().optional(),
});

/** Runs `script` with `entrypoint` in an installer container of `image` before the first start (ADR 0022). */
const ScriptInstall = z.object({ method: z.literal('script'), image: z.string(), entrypoint: z.string(), script: z.string() });

/** How the game is stopped: a signal or a console command (default: SIGTERM). */
const Stop = z.union([z.strictObject({ signal: z.enum(['SIGINT', 'SIGTERM']) }), z.strictObject({ command: z.string().min(1) })]);

const Capabilities = z.looseObject({
  // Query protocol the agent uses for the player list (ADR 0009); `port`: the port's name, default the first.
  players: z.object({ protocol: z.enum(['minecraft', 'a2s']), port: z.string().optional() }).optional(),
  // How players wake a sleeping server by connecting (ADR 0013); needs `players`.
  sleep: z.object({ wake: z.enum(['minecraft']) }).optional(),
  // Console commands for a consistent backup of a running server (ADR 0016).
  // `exclude`: top-level entries left out (downloaded server files), a name or `*.jar`.
  backup: z
    .object({
      before: z.array(z.string()).default([]),
      ready: z.string().optional(),
      after: z.array(z.string()).default([]),
      exclude: z.array(z.string().regex(/^\*?[A-Za-z0-9._-]+$/)).default([]),
    })
    .optional(),
});

/** A template file as written; variants only contain what differs from their base. */
const TemplateFile = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)?$/),
  abstract: z.boolean().default(false),
  extends: z.string().optional(),
  game: z.object({ id: z.string(), name: z.string() }).optional(),
  variant: z.object({ id: z.string(), name: z.string(), description: Localized.optional() }).optional(),
  install: z.discriminatedUnion('method', [z.object({ method: z.enum(['image', 'download', 'steamcmd']) }), ScriptInstall]).optional(),
  // `startup`: the command the image runs (Pterodactyl STARTUP); `mountPath`: where the data directory is mounted.
  runtime: z
    .object({
      image: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      java: JavaImages.optional(),
      startup: z.string().optional(),
      mountPath: AbsolutePath.optional(),
    })
    .optional(),
  versions: z.object({ provider: z.enum(PROVIDERS) }).optional(),
  content: z.array(ContentKind).optional(),
  share: Share.optional(),
  ports: z.array(Port).optional(),
  config: z.array(ConfigField).optional(),
  lifecycle: z.object({ ready: z.string().optional(), stopTimeoutSecs: z.number().int().positive().optional(), stop: Stop.optional() }).optional(),
  capabilities: Capabilities.optional(),
  files: z.array(z.object({ path: ConfigPath, description: Localized.optional() })).optional(),
});
type TemplateFile = z.infer<typeof TemplateFile>;

/** A template after resolving `extends`; everything required is present. */
const Template = z
  .object({
    id: z.string(),
    game: z.object({ id: z.string(), name: z.string() }),
    variant: z.object({ id: z.string(), name: z.string(), description: Localized.optional() }),
    install: z.discriminatedUnion('method', [z.object({ method: z.literal('image') }), ScriptInstall]),
    runtime: z.object({
      image: z.string(),
      env: z.record(z.string(), z.string()).default({}),
      java: JavaImages.optional(),
      startup: z.string().optional(),
      mountPath: AbsolutePath.optional(),
    }),
    versions: z.object({ provider: z.enum(PROVIDERS) }).optional(),
    content: z.array(ContentKind).default([]),
    share: Share.optional(),
    ports: z
      .array(Port)
      .min(1)
      .transform((ports) => ports.map((p, i) => ({ ...p, offset: p.offset ?? i }))),
    config: z.array(ConfigField),
    lifecycle: z.object({ ready: z.string().optional(), stopTimeoutSecs: z.number().default(30), stop: Stop.optional() }),
    // Config files owners and admins edit as text (ADR 0011).
    files: z.array(z.object({ path: ConfigPath, description: Localized.optional() })).default([]),
    capabilities: Capabilities,
  })
  .refine((t) => new Set(t.ports.map((p) => p.offset)).size === t.ports.length, 'Two ports have the same offset')
  .refine(
    (t) => !t.capabilities.players?.port || t.ports.some((p) => p.name === t.capabilities.players?.port),
    'capabilities.players.port names no port',
  );
export type Template = z.infer<typeof Template>;

export type Settings = Record<string, SettingValue>;
type Field = Pick<TemplateConfigField, 'type' | 'min' | 'max' | 'pattern'>;

/**
 * A modpack as the image takes it: a Modrinth slug or ID, a link (project or version page, or a
 * hosted .mrpack), or a .mrpack uploaded into the server's files (seen as /data in the container).
 */
const MODPACK = /^([A-Za-z0-9_.-]{1,64}|https:\/\/[^\s]{1,500}|\/data\/[A-Za-z0-9._\/-]{1,200}\.mrpack)$/;

/** Returns why a value does not fit a field, or null if it does. Values are never converted. */
function checkValue(field: Field, value: unknown): string | null {
  switch (field.type) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be a whole number';
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    case 'version':
      // Whether the version exists is checked against the provider's list, which needs the network.
      return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? null : 'is not a version name';
    case 'modpack':
      // Whether the pack exists is checked on Modrinth, which needs the network.
      return typeof value === 'string' && MODPACK.test(value) ? null : 'is not a Modrinth modpack name or link';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'string':
    case 'secret':
      if (typeof value !== 'string') return 'must be text';
      // ponytail: an empty secret is refused until the panel generates one per server (ADR 0022)
      if (field.type === 'secret' && value === '') return 'must not be empty';
      if (field.min !== undefined && value.length < field.min) return `must be at least ${field.min} characters`;
      if (field.max !== undefined && value.length > field.max) return `must be at most ${field.max} characters`;
      return field.pattern && !new RegExp(field.pattern).test(value) ? 'has an invalid value' : null;
  }
}

/** JSON Schema of a template file as written, for editors and the templates repo's CI. */
export function templateFileSchema() {
  return z.toJSONSchema(TemplateFile, { io: 'input' });
}

/** Merges a variant over its base: objects merge (runtime.env too), arrays and values replace. */
function merge(base: TemplateFile, variant: TemplateFile): TemplateFile {
  return {
    ...base,
    ...variant,
    abstract: variant.abstract,
    runtime: { ...base.runtime, ...variant.runtime, env: { ...base.runtime?.env, ...variant.runtime?.env } },
    versions: variant.versions ?? base.versions,
    lifecycle: { ...base.lifecycle, ...variant.lifecycle },
    capabilities: { ...base.capabilities, ...variant.capabilities },
  };
}

export class TemplateCatalog {
  private readonly templates = new Map<string, Template>();

  constructor(files: TemplateFile[]) {
    const byId = new Map(files.map((f) => [f.id, f]));
    const resolve = (file: TemplateFile, seen: string[] = []): TemplateFile => {
      if (!file.extends) return file;
      if (seen.includes(file.id)) throw new Error(`Template ${file.id}: circular "extends"`);
      const base = byId.get(file.extends);
      if (!base) throw new Error(`Template ${file.id}: base "${file.extends}" not found`);
      return merge(resolve(base, [...seen, file.id]), file);
    };
    for (const file of files) {
      const resolved = resolve(file);
      if (resolved.abstract) continue;
      const result = Template.safeParse(resolved);
      if (!result.success) throw new Error(`Template ${file.id} is incomplete:\n${z.prettifyError(result.error)}`);
      this.templates.set(file.id, result.data);
    }
  }

  static fromDirectory(dir: string): TemplateCatalog {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => {
        const result = TemplateFile.safeParse(parse(readFileSync(join(dir, f), 'utf8')));
        if (!result.success) throw new Error(`Template file ${f} is invalid:\n${z.prettifyError(result.error)}`);
        return result.data;
      });
    return new TemplateCatalog(files);
  }

  get(id: string): Template | undefined {
    return this.templates.get(id);
  }

  list(): TemplateSummary[] {
    return [...this.templates.values()].map((t) => ({
      id: t.id,
      game: t.game,
      variant: t.variant,
      config: t.config.map(({ env: _env, limit: _limit, values: _values, ...field }): TemplateConfigField => field),
      files: t.files,
      content: t.content.map((c) => ({ kind: c.kind, label: c.label, path: c.path, sources: c.sources.map((s) => s.provider) })),
      share: t.share?.format ?? null,
    }));
  }
}

/** Stored settings without keys the template dropped since, so template updates never block a server. */
export function knownSettings(template: Template, settings: Settings): Settings {
  return Object.fromEntries(Object.entries(settings).filter(([k]) => template.config.some((f) => f.key === k)));
}

/** Applies defaults and checks every value against the template. Unknown keys are rejected. */
export function validateSettings(template: Template, input: Settings): { settings: Settings } | { error: string } {
  const unknown = Object.keys(input).filter((k) => !template.config.some((f) => f.key === k));
  if (unknown.length) return { error: `Unknown settings: ${unknown.join(', ')}` };

  const settings: Settings = {};
  for (const field of template.config) {
    const value = input[field.key] ?? field.default;
    const problem = checkValue(field, value);
    if (problem) return { error: `${field.key} ${problem}` };
    settings[field.key] = value;
  }
  return { settings };
}

/** What players see while a server sleeps, in English and German (one line each). */
export const WAKE_TEXTS = {
  status: 'Sleeping – join to wake it up\nSchläft – zum Aufwecken beitreten',
  join: 'Waking up – join again in a minute.\nWird geweckt – tritt in einer Minute wieder bei.',
};

/** Turns template + validated settings into the game-neutral spec the agent runs (ADR 0005). */
export function buildSpec(template: Template, settings: Settings, hostPort: number, image = template.runtime.image): RuntimeSpec {
  const env = { ...template.runtime.env };
  let memoryMb = 1024;
  let sleepMinutes = 0;
  for (const field of template.config) {
    const value = settings[field.key];
    if (field.env) env[field.env] = String(value);
    if (field.limit === 'memory') memoryMb = Number(value);
    if (field.limit === 'sleep') sleepMinutes = Number(value);
  }
  const { sleep } = template.capabilities;
  // ponytail: only Minecraft queries reach the agent until it speaks A2S (ADR 0022)
  const players = template.capabilities.players?.protocol === 'minecraft' ? { protocol: 'minecraft' as const } : undefined;
  return {
    image,
    env,
    // M1: one port per server. Templates with several ports get consecutive host ports later.
    ports: [{ containerPort: template.ports[0].container, hostPort, protocol: template.ports[0].protocol }],
    memoryMb,
    readyPattern: template.lifecycle.ready ?? null,
    stopTimeoutSecs: template.lifecycle.stopTimeoutSecs,
    // ponytail: the query answers on the game port; templates with a separate query port name it later
    query: players ? { protocol: players.protocol, port: hostPort } : null,
    // Only a server whose players can be counted can tell that nobody is online.
    sleep:
      players && sleepMinutes > 0
        ? {
            idleMinutes: sleepMinutes,
            wake: sleep ? { protocol: sleep.wake, port: hostPort, statusText: WAKE_TEXTS.status, joinText: WAKE_TEXTS.join } : null,
          }
        : null,
  };
}
