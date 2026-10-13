import { open, type FileHandle } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP (APPNOTE 6.3) writer for investigation exports: deflate or
 * stored members, UTF-8 names, no ZIP64. Limits follow the format without
 * ZIP64: fewer than 65,535 members and every offset and size below 4 GiB;
 * exceeding either throws instead of writing a corrupt archive.
 */
const MAX_U32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;
const SAFE_NAME = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

interface Central {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  method: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

const dosDateTime = (date: Date): { dosTime: number; dosDate: number } => ({
  dosTime:
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2),
  dosDate:
    ((Math.max(1980, date.getUTCFullYear()) - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate(),
});

export class ZipWriter {
  private readonly entries: Central[] = [];
  private readonly names = new Set<string>();
  private offset = 0;

  private constructor(
    private readonly file: FileHandle,
    private readonly modified: Date,
  ) {}

  static async create(path: string, modified = new Date()): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "wx", 0o600), modified);
  }

  private async write(buffer: Buffer): Promise<void> {
    await this.file.write(buffer);
    this.offset += buffer.length;
    if (this.offset > MAX_U32)
      throw new RangeError("export exceeds 4 GiB; ZIP64 is not supported");
  }

  /** Add one member; names are relative paths of [A-Za-z0-9._-] segments. */
  async add(name: string, data: Buffer): Promise<void> {
    if (
      !SAFE_NAME.test(name) ||
      name.split("/").some((s) => s === "." || s === "..")
    )
      throw new TypeError(`unsafe zip member name: ${JSON.stringify(name)}`);
    if (this.names.has(name))
      throw new TypeError(`duplicate zip member name: ${name}`);
    if (this.entries.length >= MAX_ENTRIES - 1)
      throw new RangeError("too many zip members; ZIP64 is not supported");
    if (data.length > MAX_U32)
      throw new RangeError(`zip member ${name} exceeds 4 GiB`);
    this.names.add(name);
    const deflated = deflateRawSync(data, { level: 6 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const nameBytes = Buffer.from(name, "utf8");
    const { dosTime, dosDate } = dosDateTime(this.modified);
    const entry: Central = {
      name: nameBytes,
      crc: crc32(data) >>> 0,
      compressed: body.length,
      size: data.length,
      method,
      offset: this.offset,
      dosTime,
      dosDate,
    };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressed, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    await this.write(header);
    await this.write(nameBytes);
    await this.write(body);
    this.entries.push(entry);
  }

  /** Write the central directory and close the file. Returns its size. */
  async finish(): Promise<number> {
    try {
      const start = this.offset;
      for (const e of this.entries) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(0x0314, 4); // made by: UNIX, 2.0
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(e.method, 10);
        header.writeUInt16LE(e.dosTime, 12);
        header.writeUInt16LE(e.dosDate, 14);
        header.writeUInt32LE(e.crc, 16);
        header.writeUInt32LE(e.compressed, 20);
        header.writeUInt32LE(e.size, 24);
        header.writeUInt16LE(e.name.length, 28);
        header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, 0644
        header.writeUInt32LE(e.offset, 42);
        await this.write(header);
        await this.write(e.name);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(this.offset - start, 12);
      end.writeUInt32LE(start, 16);
      await this.write(end);
      return this.offset;
    } finally {
      await this.file.close();
    }
  }

  async abort(): Promise<void> {
    await this.file.close().catch(() => undefined);
  }
}
