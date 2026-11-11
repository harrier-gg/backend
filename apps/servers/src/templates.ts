// Templates (ADR 0005): load YAML files, resolve `extends`, validate settings and build the
// game-neutral runtime spec the agent executes. Everything game-specific stays here.
import type { TemplateConfigField, TemplateSummary } from '@harrier-gg/contracts';
import type { RuntimeSpec } from '@harrier-gg/protocol';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Localized = z.object({ en: z.string(), de: z.string().optional() });

const ConfigField = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    label: Localized,
    type: z.enum(['string', 'integer', 'boolean', 'select']),
    default: z.union([z.string(), z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    /** Choices of a `select` field. */
    options: z.array(z.object({ value: z.string(), label: Localized })).min(1).optional(),
    // Where the value goes: an environment variable or a resource limit.
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    limit: z.enum(['memory']).optional(),
  })
  .refine((f) => (f.type === 'select') === (f.options !== undefined), 'A select field needs options, other fields none')
  .refine((f) => checkValue(f, f.default) === null, 'The default does not fit the field');

/** A template file as written; variants only contain what differs from their base. */
const TemplateFile = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)?$/),
  abstract: z.boolean().default(false),
  extends: z.string().optional(),
  game: z.object({ id: z.string(), name: z.string() }).optional(),
  variant: z.object({ id: z.string(), name: z.string(), description: Localized.optional() }).optional(),
  install: z.object({ method: z.enum(['image', 'download', 'steamcmd', 'script']) }).optional(),
  runtime: z
    .object({ image: z.string().optional(), env: z.record(z.string(), z.string()).optional() })
    .optional(),
  ports: z
    .array(z.object({ name: z.string(), container: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']) }))
    .optional(),
  config: z.array(ConfigField).optional(),
  lifecycle: z.object({ ready: z.string().optional(), stopTimeoutSecs: z.number().int().positive().optional() }).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});
type TemplateFile = z.infer<typeof TemplateFile>;

/** A template after resolving `extends`; everything required is present. */
const Template = z.object({
  id: z.string(),
  game: z.object({ id: z.string(), name: z.string() }),
  variant: z.object({ id: z.string(), name: z.string(), description: Localized.optional() }),
  install: z.object({ method: z.literal('image') }), // M1 only runs image-based templates
  runtime: z.object({ image: z.string(), env: z.record(z.string(), z.string()) }),
  ports: z.array(z.object({ name: z.string(), container: z.number(), protocol: z.enum(['tcp', 'udp']) })).min(1),
  config: z.array(ConfigField),
  lifecycle: z.object({ ready: z.string().optional(), stopTimeoutSecs: z.number().default(30) }),
  capabilities: z.looseObject({
    // Query protocol the agent uses for the player list (ADR 0009).
    players: z.object({ protocol: z.enum(['minecraft']) }).optional(),
  }),
});
export type Template = z.infer<typeof Template>;

export type Settings = Record<string, string | number | boolean>;
type Field = Pick<TemplateConfigField, 'type' | 'min' | 'max' | 'pattern' | 'options'>;

/** Returns why a value does not fit a field, or null if it does. Values are never converted. */
function checkValue(field: Field, value: unknown): string | null {
  switch (field.type) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be a whole number';
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'select':
      return field.options?.some((o) => o.value === value) ? null : 'is not one of the options';
    case 'string':
      if (typeof value !== 'string') return 'must be text';
      return field.pattern && !new RegExp(field.pattern).test(value) ? 'has an invalid value' : null;
  }
}

/** Merges a variant over its base: objects merge (runtime.env too), arrays and values replace. */
function merge(base: TemplateFile, variant: TemplateFile): TemplateFile {
  return {
    ...base,
    ...variant,
    abstract: variant.abstract,
    runtime: { ...base.runtime, ...variant.runtime, env: { ...base.runtime?.env, ...variant.runtime?.env } },
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
      config: t.config.map(({ env: _env, limit: _limit, ...field }): TemplateConfigField => field),
    }));
  }
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

/** Turns template + validated settings into the game-neutral spec the agent runs (ADR 0005). */
export function buildSpec(template: Template, settings: Settings, hostPort: number): RuntimeSpec {
  const env = { ...template.runtime.env };
  let memoryMb = 1024;
  for (const field of template.config) {
    const value = settings[field.key];
    if (field.env) env[field.env] = String(value);
    if (field.limit === 'memory') memoryMb = Number(value);
  }
  return {
    image: template.runtime.image,
    env,
    // M1: one port per server. Templates with several ports get consecutive host ports later.
    ports: [{ containerPort: template.ports[0].container, hostPort, protocol: template.ports[0].protocol }],
    memoryMb,
    readyPattern: template.lifecycle.ready ?? null,
    stopTimeoutSecs: template.lifecycle.stopTimeoutSecs,
    // ponytail: the query answers on the game port; templates with a separate query port name it later
    query: template.capabilities.players ? { protocol: template.capabilities.players.protocol, port: hostPort } : null,
  };
}
