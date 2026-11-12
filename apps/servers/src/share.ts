// Sharing player content (ADR 0018): a pack friends import into their launcher. Formats are
// adapters like content providers; the first is Modrinth's `.mrpack`.
import { crc32 } from 'node:zlib';
import { fetchJson, type FetchJson } from './versions';

/** Installed content as it goes into a pack. */
export interface PackFile {
  name: string;
  path: string;
  url: string | null;
  size: number | null;
  sha1: string | null;
  sha512: string | null;
  side: string | null;
}

/** What players need: content the server does not need alone. Unknown sides go in too. */
export const forPlayers = (side: string | null) => side !== 'server';

/** The newest stable loader for a game version, as the pack's dependency. */
export async function loaderVersion(loader: string, gameVersion: string, fetch: FetchJson = fetchJson): Promise<string> {
  switch (loader) {
    case 'fabric-loader': {
      const versions = (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(gameVersion)}`)) as { loader: { version: string; stable: boolean } }[];
      const loader = versions.find((v) => v.loader.stable) ?? versions[0];
      if (!loader) throw new Error(`Fabric has no loader for ${gameVersion}`);
      return loader.loader.version;
    }
    default:
      throw new Error(`Unknown loader ${loader}`);
  }
}

/**
 * `modrinth.index.json` (https://support.modrinth.com/en/articles/8802351). Files without a URL or
 * both hashes cannot be in a pack; they are returned as `missing`.
 */
export function mrpackIndex(pack: { name: string; versionId: string; gameVersion: string; loader: string; loaderVersion: string; files: PackFile[] }) {
  const usable = pack.files.filter((f) => f.url?.startsWith('https://') && f.sha1 && f.sha512);
  return {
    index: {
      formatVersion: 1,
      game: 'minecraft',
      versionId: pack.versionId,
      name: pack.name,
      summary: `Mods for ${pack.name}, shared by Harrier`,
      files: usable.map((f) => ({
        path: f.path,
        hashes: { sha1: f.sha1, sha512: f.sha512 },
        // Only players get mods the server cannot run.
        env: { client: 'required', server: f.side === 'client' ? 'unsupported' : 'required' },
        downloads: [f.url],
        fileSize: f.size ?? 0,
      })),
      dependencies: { minecraft: pack.gameVersion, [pack.loader]: pack.loaderVersion },
    },
    missing: pack.files.filter((f) => !usable.includes(f)).map((f) => f.name),
  };
}

/** A ZIP with one stored (uncompressed) entry; enough for a pack's index. */
export function zipOne(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  // DOS date 1980-01-01, so the same content always gives the same file.
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0x21, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE(20, 4); // made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  // extra, comment, disk, internal and external attributes stay 0
  central.writeUInt32LE(0, 42); // offset of the local header

  const centralOffset = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}
