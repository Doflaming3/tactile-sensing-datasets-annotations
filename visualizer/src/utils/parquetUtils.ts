import {
  asyncBufferFromUrl,
  cachedAsyncBuffer,
  parquetRead,
  parquetReadObjects,
  type AsyncBuffer,
  parquetMetadataAsync,
  parquetSchema,
} from "hyparquet";
import { authHeaders } from "./auth";

export interface DatasetMetadata {
  codebase_version: string;
  robot_type: string;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  total_videos: number;
  total_chunks: number;
  chunks_size: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string;
  features: Record<
    string,
    {
      dtype: string;
      shape: number[];
      names: string[] | Record<string, unknown> | null;
      info?: Record<string, unknown>;
    }
  >;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch JSON ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

export function formatStringWithVars(
  format: string,
  vars: Record<string, string | number>,
): string {
  return format.replace(/{(\w+)(?::\d+d)?}/g, (_, key) => String(vars[key]));
}

// Fetch and parse the Parquet file
type ParquetFile = ArrayBuffer | AsyncBuffer;

const parquetFileCache = new Map<string, AsyncBuffer>();

export async function fetchParquetFile(url: string): Promise<ParquetFile> {
  const cached = parquetFileCache.get(url);
  if (cached) return cached;

  const file = await asyncBufferFromUrl({
    url,
    requestInit: { cache: "no-store", headers: authHeaders() },
  });
  const wrapped = cachedAsyncBuffer(file);
  parquetFileCache.set(url, wrapped);
  return wrapped;
}

// List the column names actually present in a parquet file. Lets callers
// request optional columns (e.g. language_instruction) without hyparquet
// throwing "parquet column not found" on datasets that lack them.
export async function parquetColumnNames(
  fileBuffer: ParquetFile,
): Promise<string[]> {
  const metadata = await parquetMetadataAsync(fileBuffer as AsyncBuffer);
  const root = parquetSchema(metadata);
  return root.children.map((c) => c.element.name);
}

// Read specific columns from the Parquet file
export async function readParquetColumn(
  fileBuffer: ParquetFile,
  columns: string[],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    try {
      parquetRead({
        file: fileBuffer,
        columns: columns.length > 0 ? columns : undefined,
        rowStart: options?.rowStart,
        rowEnd: options?.rowEnd,
        onComplete: (data: unknown[][]) => {
          resolve(data);
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function readParquetAsObjects(
  fileBuffer: ParquetFile,
  columns: string[] = [],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({
    file: fileBuffer,
    columns: columns.length > 0 ? columns : undefined,
    rowStart: options?.rowStart,
    rowEnd: options?.rowEnd,
  }) as Promise<Record<string, unknown>[]>;
}

// A ranged read of a file with ONE row group decodes every page anyway
// (hyparquet skips row groups, not rows), so a per-episode read of such a
// file costs a full decode each time — seconds, and a few hundred MB
// transient — with all 163 sotac episodes in one 2.1 MB file. The whole
// file is decoded once and sliced per episode instead. Decoded rows are
// kept COMPACT: a column of fixed-shape numeric arrays (the tactile
// [2][52][3] per row, state, action) becomes one typed array plus its
// shape, and row objects are rebuilt only for the slice asked for. As
// nested JS arrays that file is ~400 MB per thread; compact it is ~75 MB,
// which is what lets four batch threads each hold one. One entry — the
// file of the current episode.

type CompactColumn =
  | {
      kind: "typed";
      data: Float32Array | Float64Array;
      shape: number[];
      stride: number;
    }
  | { kind: "plain"; values: unknown[] };

export interface CompactRows {
  nRows: number;
  columns: Map<string, CompactColumn>;
}

/** Shape of a rectangular nested array of numbers ([] for a number, null
 * for anything else). Inner lengths are checked when flattening. */
function numericShape(v: unknown): number[] | null {
  if (typeof v === "number") return [];
  if (!Array.isArray(v) || v.length === 0) return null;
  const inner = numericShape(v[0]);
  return inner ? [v.length, ...inner] : null;
}

/** Writes the leaves of `v` into `out` from `at`; false when the nesting
 * does not match `shape`. */
function flattenInto(
  v: unknown,
  shape: number[],
  out: Float32Array | Float64Array,
  at: number,
): boolean {
  if (shape.length === 0) {
    if (typeof v !== "number") return false;
    out[at] = v;
    return true;
  }
  if (!Array.isArray(v) || v.length !== shape[0]) return false;
  const inner = shape.slice(1);
  const step = inner.reduce((a, b) => a * b, 1);
  for (let i = 0; i < v.length; i++) {
    if (!flattenInto(v[i], inner, out, at + i * step)) return false;
  }
  return true;
}

function reshape(
  data: Float32Array | Float64Array,
  at: number,
  shape: number[],
): unknown {
  if (shape.length === 0) return data[at];
  const inner = shape.slice(1);
  const step = inner.reduce((a, b) => a * b, 1);
  const out = new Array(shape[0]);
  for (let i = 0; i < shape[0]; i++)
    out[i] = reshape(data, at + i * step, inner);
  return out;
}

/** Compacts decoded rows column by column: every value a non-null
 * rectangular numeric array of one shape → a typed array (Float32 when the
 * parquet leaf is FLOAT, Float64 otherwise); anything else stays a plain
 * array of the values. Scalars stay plain too (BigInt, strings, and the
 * rare row-level nulls keep their identity). */
export function compactRows(
  rows: Record<string, unknown>[],
  columns: string[],
  floatColumns: Set<string> = new Set(),
): CompactRows {
  const nRows = rows.length;
  const names = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  const out = new Map<string, CompactColumn>();
  for (const name of names) {
    let first: unknown = undefined;
    for (const r of rows) {
      if (r[name] !== undefined && r[name] !== null) {
        first = r[name];
        break;
      }
    }
    const shape = first === undefined ? null : numericShape(first);
    let typed: CompactColumn | null = null;
    if (shape && shape.length > 0) {
      const stride = shape.reduce((a, b) => a * b, 1);
      const data = floatColumns.has(name)
        ? new Float32Array(nRows * stride)
        : new Float64Array(nRows * stride);
      let ok = true;
      for (let i = 0; i < nRows && ok; i++) {
        ok = flattenInto(rows[i][name], shape, data, i * stride);
      }
      if (ok) typed = { kind: "typed", data, shape, stride };
    }
    out.set(name, typed ?? { kind: "plain", values: rows.map((r) => r[name]) });
  }
  return { nRows, columns: out };
}

/** Row objects for [rowStart, rowEnd), fresh each call. */
export function materializeRows(
  compact: CompactRows,
  rowStart: number,
  rowEnd: number,
): Record<string, unknown>[] {
  const a = Math.max(0, rowStart);
  const b = Math.min(compact.nRows, rowEnd);
  const rows: Record<string, unknown>[] = [];
  for (let i = a; i < b; i++) {
    const row: Record<string, unknown> = {};
    for (const [name, col] of compact.columns) {
      row[name] =
        col.kind === "typed"
          ? reshape(col.data, i * col.stride, col.shape)
          : col.values[i];
    }
    rows.push(row);
  }
  return rows;
}

let decodedFile: {
  file: ParquetFile;
  key: string;
  rows: CompactRows;
} | null = null;

/** Top-level columns whose (first) leaf is a parquet FLOAT: decoded as
 * JS numbers that a Float32Array holds without loss. */
function floatLeafColumns(
  metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>,
): Set<string> {
  const out = new Set<string>();
  try {
    for (const child of parquetSchema(metadata).children) {
      let node = child;
      while (node.children && node.children.length > 0) node = node.children[0];
      if (node.element.type === "FLOAT") out.add(child.element.name);
    }
  } catch {
    /* schema without types: everything stays Float64 */
  }
  return out;
}

export async function readRowRange(
  fileBuffer: ParquetFile,
  columns: string[],
  rowStart: number,
  rowEnd: number,
): Promise<Record<string, unknown>[]> {
  const metadata = await parquetMetadataAsync(fileBuffer as AsyncBuffer);
  if (metadata.row_groups.length !== 1) {
    return readParquetAsObjects(fileBuffer, columns, { rowStart, rowEnd });
  }
  const key = columns.join("\u0000");
  if (
    !decodedFile ||
    decodedFile.file !== fileBuffer ||
    decodedFile.key !== key
  ) {
    decodedFile = null; // the old file goes before the new decode's peak
    const rows = await readParquetAsObjects(fileBuffer, columns);
    const compact = compactRows(rows, columns, floatLeafColumns(metadata));
    rows.length = 0;
    decodedFile = { file: fileBuffer, key, rows: compact };
  }
  return materializeRows(decodedFile.rows, rowStart, rowEnd);
}

/** Tests and memory-sensitive callers can drop the decoded file. */
export function clearDecodedFile(): void {
  decodedFile = null;
}

// Convert a 2D array to a CSV string
export function arrayToCSV(data: (number | string)[][]): string {
  return data.map((row) => row.join(",")).join("\n");
}

type ColumnInfo = { key: string; value: string[] };

export function getRows(currentFrameData: unknown[], columns: ColumnInfo[]) {
  if (!currentFrameData || currentFrameData.length === 0) {
    return [];
  }

  const rows: Array<Array<{ isNull: true } | unknown>> = [];
  const nRows = Math.max(...columns.map((column) => column.value.length));
  let rowIndex = 0;

  while (rowIndex < nRows) {
    const row: Array<{ isNull: true } | unknown> = [];
    // number of states may NOT match number of actions. In this case, we null-pad the 2D array
    const nullCell = { isNull: true };
    // row consists of [state value, action value]
    let idx = rowIndex;

    for (const column of columns) {
      const nColumn = column.value.length;
      row.push(rowIndex < nColumn ? currentFrameData[idx] : nullCell);
      idx += nColumn; // because currentFrameData = [state0, state1, ..., stateN, action0, action1, ..., actionN]
    }

    rowIndex += 1;
    rows.push(row);
  }

  return rows;
}
