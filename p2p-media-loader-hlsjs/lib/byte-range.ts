import { LoaderContext } from "hls.js";

export type ByteRange = { length: number; offset: number } | undefined;

export function getByteRange(context: LoaderContext): { offset: number, length: number } | undefined {
  return context.rangeEnd && context.rangeStart !== undefined
      ? { offset: context.rangeStart, length: context.rangeEnd - context.rangeStart }
      : undefined;
}

export function compareByteRanges(b1: ByteRange, b2: ByteRange): boolean {
  return b1 === undefined ? b2 === undefined : b2 !== undefined && b1.length === b2.length && b1.offset === b2.offset;
}

export function byteRangeToString(byteRange: ByteRange): string | undefined {
  if (byteRange === undefined) {
      return undefined;
  }

  const end = byteRange.offset + byteRange.length - 1;

  return `bytes=${byteRange.offset}-${end}`;
}
