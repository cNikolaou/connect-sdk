import {
  Layout,
  LayoutItem,
  LengthPrefixedBytesLayoutItem,
  isPrimitiveType,
} from "./layout";

import { serializeUint } from "./serialize";

//defining a bunch of types for readability
type Uint = number;
type Bitset = bigint;
type Size = Uint;
type BytePos = Uint;
type ByteVal = Uint; //actually a uint8
type LayoutIndex = Uint;
type Candidates = Bitset;
type FixedBytes = (readonly [BytePos, Uint8Array])[];
//using a Bounds type (even though currently the upper bound can only either be equal to the lower
//  bound or Infinity) in anticipation of a future switch layout item that might contain multiple
//  sublayouts which, unlike arrays currently, could all be bounded but potentially with
//  different sizes
type Bounds = readonly [Size, Size];

function arrayToBitset(arr: readonly number[]): Bitset {
  return arr.reduce((bit, i) => bit | BigInt(1) << BigInt(i), BigInt(0));
}

function bitsetToArray(bitset: Bitset): number[] {
  const ret = [];
  for (let i = 0n; bitset > 0n; bitset >>= 1n, ++i)
    if (bitset & 1n)
      ret.push(Number(i));

  return ret;
}

function count(candidates: Candidates) {
  let count = 0;
  for (; candidates > 0n; candidates >>= 1n)
    count += Number(candidates & 1n);
  return count;
}

function layoutItemMeta(
  item: LayoutItem,
  offset: BytePos,
  fixedBytes: FixedBytes,
): Bounds {
  function knownFixed(size: Size, serialized: Uint8Array): Bounds {
    if (Number.isFinite(offset))
      fixedBytes.push([offset, serialized]);

    return [size, size];
  }

  switch (item.binary) {
    case "object": {
      return createLayoutMeta(item.layout, offset, fixedBytes);
    }
    case "array": {
      return [item.lengthSize !== undefined ? item.lengthSize : 0, Infinity];
    }
    case "bytes": {
      if ("size" in item && item.size !== undefined)
        return [item.size, item.size];

      if (item?.custom instanceof Uint8Array)
        return knownFixed(item.custom.length, item.custom);

      if (item?.custom?.from instanceof Uint8Array)
        return knownFixed(item.custom.from.length, item.custom.from);

      //TODO typescript should be able to infer that at this point the only possible remaining
      //  type for item is LengthPrefixedBytesLayoutItem, but for some reason it doesn't
      item = item as LengthPrefixedBytesLayoutItem;
      return [item.lengthSize !== undefined ? item.lengthSize : 0, Infinity];
    }
    case "uint": {
      if (isPrimitiveType(item.custom)) {
        const serialized = new Uint8Array(item.size);
        serializeUint(serialized, 0, item.custom, item.size)
        return knownFixed(item.size, serialized);
      }

      return [item.size, item.size];
    }
  }
}

function createLayoutMeta(
  layout: Layout,
  offset: BytePos,
  fixedBytes: FixedBytes
): Bounds {
  let bounds = [0, 0] as Bounds;
  for (const item of layout) {
    bounds = layoutItemMeta(item, offset, fixedBytes)
      //we need the cast because of course mapping tuples to tuples is an unsolved problem in TS:
      //https://stackoverflow.com/questions/57913193/how-to-use-array-map-with-tuples-in-typescript#answer-57913509
      .map((b, i) => bounds[i] + b) as unknown as Bounds;
    offset = bounds[0] === bounds[1] ? bounds[0] : Infinity;
  }
  return bounds;
}

function buildAscendingBounds(sortedBounds: readonly (readonly [Bounds, LayoutIndex])[]) {
  const ascendingBounds = new Map<Size, Candidates>();
  //sortedCandidates tracks all layouts that have a size bound that contains the size that's
  //  currently under consideration, sorted in ascending order of their respective upper bounds
  let sortedCandidates = [] as (readonly [Size, LayoutIndex])[];
  const closeCandidatesBefore = (before: number) => {
    while (sortedCandidates.length > 0 && sortedCandidates[0][0] < before) {
      const end = sortedCandidates[0][0] + 1;
      //remove all candidates that end at the same position
      const removeIndex = sortedCandidates.findIndex(([upper]) => end <= upper);
      if (removeIndex === -1)
        sortedCandidates = [];
      else
        sortedCandidates.splice(0, removeIndex);
      //introduce a new bound that captures all candidates that can have a size of at least `end`
      ascendingBounds.set(end, arrayToBitset(sortedCandidates.map(([, j]) => j)));
    }
  };

  for (const [[lower, upper], i] of sortedBounds) {
    closeCandidatesBefore(lower);
    const insertIndex = sortedCandidates.findIndex(([u]) => u > upper);
    if (insertIndex === -1)
      sortedCandidates.push([upper, i]);
    else
      sortedCandidates.splice(insertIndex, 0, [upper, i]);

    ascendingBounds.set(lower, arrayToBitset(sortedCandidates.map(([, j]) => j)));
  }
  closeCandidatesBefore(Infinity);

  return ascendingBounds;
}

//Generates a greedy divide-and-conquer strategy to determine the layout (or set of layouts) that
//  a given serialized byte array might conform to.
//It leverages size bounds and known fixed bytes of layouts to quickly eliminate candidates, by
//  (greedily) choosing the discriminator (byte or size) that eliminates the most candidates at
//  each step.
//Power is a relative measure of the strength of a discriminator given a set of layout candidates.
//  It's in [0, candidate.length - 1] and states how many layouts of that set can _at least_ be
//  eliminated when applying that discriminator.
//Layout sizes are only tracked in terms of lower and upper bounds. This means that while a layout
//  like an array of e.g. 2 byte uints can actually never have an odd size, the algorithm will
//  simply treat it as having a size bound of [0, Infinity]. This means that the algorithm is
//  "lossy" in the sense that it does not use all the information that it actually has available
//  and will e.g. wrongly conclude that the aforementioned layout cannot be distinguished from a
//  second layout that starts off with a one byte uint followed by an array of 2 byte uints (and
//  would thus always have odd size). I.e. it would wrongly conclude that the power of the size
//  discriminator is 0 when it should be 1.
//The alternative to accepting this limitation is tracking all possible combinations of offsets,
//  multiples, and their arbitrary composition which would be massively more complicated and
//  also pointless in the general case because we'd have to figure out whether a given size can be
//  expressed as some combination of offsets and array size multiples in which case it's almost
//  certainly computaionally cheaper to simply attempt to deserialize the given given data for the
//  respective layout.
function generateLayoutDiscriminator(
  layouts: readonly Layout[]
): [boolean, (encoded: Uint8Array) => readonly LayoutIndex[]] {

  if (layouts.length === 0)
    throw new Error("Cannot discriminate empty set of layouts");

  const emptySet = 0n;
  const allLayouts = (1n << BigInt(layouts.length)) - 1n;

  const fixedKnown = layouts.map(() => [] as FixedBytes);
  const sizeBounds = layouts.map((l, i) => createLayoutMeta(l, 0, fixedKnown[i]));
  const sortedBounds = sizeBounds.map((b, i) => [b, i] as const).sort(([[l1]], [[l2]]) => l1 - l2);

  const mustHaveByteAt = (() => {
    let remaining = allLayouts;
    const ret = new Map<Size, Candidates>();
    for (const [[lower], i] of sortedBounds) {
      remaining ^= 1n << BigInt(i); //delete the i-th bit
      ret.set(lower, remaining);
    }
    return ret;
  })();
  const ascendingBounds = buildAscendingBounds(sortedBounds);
  const sizePower = layouts.length - Math.max(
    ...[...ascendingBounds.values()].map(candidates => count(candidates))
  );
  //we don't check sizePower here and bail early if it is perfect because we prefer perfect byte
  //  discriminators over perfect size discriminators due to their faster lookup times (hash map
  //  vs binary search (and actually currently everything is even implement using linear search))
  //  and more predictable / lower complexity branching behavior.
  const layoutsWithByteAt = (bytePos: BytePos) => {
    let ret = allLayouts;
    for (const [lower, candidates] of mustHaveByteAt) {
      if (bytePos < lower)
        break;

      ret = candidates;
    }
    return ret;
  };

  const layoutsWithSize = (size: Size) => {
    let ret = emptySet;
    for (const [lower, candidates] of ascendingBounds) {
      if (size < lower)
        break;

      ret = candidates;
    }
    return ret;
  };

  const fixedKnownBytes: readonly ((readonly [ByteVal, LayoutIndex])[])[] = Array.from({length:
    Math.max(...fixedKnown.map(fkb => fkb.length > 0 ? fkb.at(-1)![0] + fkb.at(-1)![1].length : 0))
  }).map(() => []);

  for (let i = 0; i < fixedKnown.length; ++i)
    for (const [offset, serialized] of fixedKnown[i])
      for (let j = 0; j < serialized.length; ++j)
        fixedKnownBytes[offset + j].push([serialized[j], i]);

  let bestBytes = [];
  for (const [bytePos, fixedKnownByte] of fixedKnownBytes.entries()) {
    //the number of layouts with a given size is an upper bound on the discriminatory power of
    //  a byte at a given position: If the encoded data is too short we can automatically
    //  exclude all layouts whose minimum size is larger than it, nevermind those who expect
    //  a known, fixed value at this position.
    const lwba = layoutsWithByteAt(bytePos);
    const anyValueLayouts = lwba ^ arrayToBitset(fixedKnownByte.map(([, layoutIdx]) => layoutIdx));
    const outOfBoundsLayouts = allLayouts ^ lwba;
    const distinctValues = new Map<BytePos, Candidates>();
    //the following equation holds (after applying .length to each component):
    //layouts = outOfBoundsLayouts + anyValueLayouts + fixedKnownByte
    for (const [byteVal, candidate] of fixedKnownByte) {
      if (!distinctValues.has(byteVal))
        distinctValues.set(byteVal, emptySet);

      distinctValues.set(byteVal, distinctValues.get(byteVal)! | 1n << BigInt(candidate));
    }

    let power = count(lwba);
    for (const layoutsWithValue of distinctValues.values()) {
      //if we find the byte value associated with this set of layouts, we can eliminate
      //  all other layouts that don't have this value at this position and all layouts
      //  that are too short to have a value in this position regardless
      const curPower = fixedKnownByte.length - count(layoutsWithValue) + count(outOfBoundsLayouts);
      power = Math.min(power, curPower);
    }

    if (power === 0)
      continue;

    if (power === layouts.length - 1)
      //we have a perfect byte discriminator -> bail early
      return [
        true,
        (encoded: Uint8Array) =>
          bitsetToArray(
            encoded.length <= bytePos
            ? outOfBoundsLayouts
            : distinctValues.get(encoded[bytePos]) ?? emptySet
          )
      ];

    bestBytes.push([power, bytePos, outOfBoundsLayouts, distinctValues, anyValueLayouts] as const);
  }

  //if we get here, we know we don't have a perfect byte discriminator so we now check wether we
  //  we have a perfect size discriminator and bail early if so
  if (sizePower === layouts.length - 1)
    return [true, (encoded: Uint8Array) => bitsetToArray(layoutsWithSize(encoded.length))];

  //sort in descending order of power
  bestBytes.sort(([lhsPower], [rhsPower]) => rhsPower - lhsPower);
  type BestBytes = typeof bestBytes;
  type Strategy = [BytePos, Candidates, Map<number, Candidates>] | "size" | "indistinguishable";

  let distinguishable = true;
  let firstStrategy: Strategy | undefined;
  const strategies = new Map<Candidates, Strategy>();
  const candidatesBySize = new Map<Size, Candidates[]>();
  const addStrategy = (candidates: Candidates, strategy: Strategy) => {
    if (firstStrategy === undefined) {
      firstStrategy = strategy;
      return;
    }

    strategies.set(candidates, strategy);
    if (!candidatesBySize.has(count(candidates)))
      candidatesBySize.set(count(candidates), []);
    candidatesBySize.get(count(candidates))!.push(candidates);
  };

  const recursivelyBuildStrategy = (
    candidates: Candidates,
    bestBytes: BestBytes,
  ) => {
    if (count(candidates) <= 1 || strategies.has(candidates))
      return;

    let sizePower = 0;
    const narrowedBounds = new Map<Size, Candidates>();
    for (const candidate of bitsetToArray(candidates)) {
      const lower = sizeBounds[candidate][0];
      const overlap = ascendingBounds.get(lower)! & candidates;
      narrowedBounds.set(lower, overlap)
      sizePower = Math.max(sizePower, count(overlap));
    }
    sizePower = count(candidates) - sizePower;

    const narrowedBestBytes = [] as BestBytes;
    for (const [power, bytePos, outOfBoundsLayouts, distinctValues, anyValueLayouts] of bestBytes) {
      const narrowedDistinctValues = new Map<ByteVal, Candidates>();
      let fixedKnownCount = 0;
      for (const [byteVal, layoutsWithValue] of distinctValues) {
        const lwv = layoutsWithValue & candidates;
        if (count(lwv) > 0) {
          narrowedDistinctValues.set(byteVal, lwv);
          fixedKnownCount += count(lwv);
        }
      }
      const narrowedOutOfBoundsLayouts = outOfBoundsLayouts & candidates;

      let narrowedPower = narrowedDistinctValues.size > 0 ? power : 0;
      for (const layoutsWithValue of narrowedDistinctValues.values()) {
        const curPower =
          fixedKnownCount - count(layoutsWithValue) + count(narrowedOutOfBoundsLayouts);
        narrowedPower = Math.min(narrowedPower, curPower);
      }

      if (narrowedPower === 0)
        continue;

      if (narrowedPower === count(candidates) - 1) {
        //if we have a perfect byte discriminator, we can bail early
        addStrategy(candidates, [bytePos, narrowedOutOfBoundsLayouts, narrowedDistinctValues]);
        return;
      }

      narrowedBestBytes.push([
        narrowedPower,
        bytePos,
        narrowedOutOfBoundsLayouts,
        narrowedDistinctValues,
        anyValueLayouts & candidates
      ] as const);
    }

    if (sizePower === count(candidates) - 1) {
      //if we have a perfect size discriminator, we can bail early
      addStrategy(candidates, "size");
      return;
    }

    narrowedBestBytes.sort(([lhsPower], [rhsPower]) => rhsPower - lhsPower);

    //prefer byte discriminators over size discriminators
    if (narrowedBestBytes.length > 0 && narrowedBestBytes[0][0] >= sizePower) {
      const [, bytePos, narrowedOutOfBoundsLayouts, narrowedDistinctValues, anyValueLayouts] =
        narrowedBestBytes[0];
      addStrategy(candidates, [bytePos, narrowedOutOfBoundsLayouts, narrowedDistinctValues]);
      recursivelyBuildStrategy(narrowedOutOfBoundsLayouts, narrowedBestBytes);
      for (const cand of narrowedDistinctValues.values())
        recursivelyBuildStrategy(cand | anyValueLayouts, narrowedBestBytes.slice(1));

      return;
    }

    if (sizePower > 0) {
      addStrategy(candidates, "size");
      for (const cands of narrowedBounds.values())
        recursivelyBuildStrategy(cands, narrowedBestBytes);

      return;
    }

    addStrategy(candidates, "indistinguishable");
    distinguishable = false;
  }

  recursivelyBuildStrategy(allLayouts, bestBytes);

  const findSmallestSuperSetStrategy = (candidates: Candidates) => {
    for (let size = count(candidates) + 1; size < layouts.length - 2; ++size)
      for (const larger of candidatesBySize.get(size) ?? [])
        if ((candidates & larger) == candidates) //is subset?
          return strategies.get(larger)!;

    throw new Error("Implementation error in layout discrimination algorithm");
  };

  return [distinguishable, (encoded: Uint8Array) => {
    let candidates = allLayouts;
    let strategy = firstStrategy!;
    while (strategy !== "indistinguishable") {
      if (strategy === "size")
        candidates &= layoutsWithSize(encoded.length);
      else {
        const [bytePos, outOfBoundsLayouts, distinctValues] = strategy;
        if (encoded.length <= bytePos)
          candidates &= outOfBoundsLayouts;
        else {
          const byteVal = encoded[bytePos];
          for (const [val, cands] of distinctValues)
            if (val !== byteVal)
              candidates ^= candidates & cands; //= candidates - cands (set minus)

          candidates ^= candidates & outOfBoundsLayouts;
        }
      }

      if (count(candidates) <= 1)
        return bitsetToArray(candidates);

      strategy = strategies.get(candidates) ?? findSmallestSuperSetStrategy(candidates);
    }

    return bitsetToArray(candidates);
  }];
}

export function layoutDiscriminator<B extends boolean = false>(
  layouts: readonly Layout[],
  allowAmbiguous?: B
) {
  const [distinguishable, discriminator] = generateLayoutDiscriminator(layouts);
  if (!distinguishable && !allowAmbiguous)
    throw new Error("Cannot uniquely distinguished the given layouts");

  return (
    !allowAmbiguous
    ? (encoded: Uint8Array) => {
      const layout = discriminator(encoded);
      return layout.length === 0 ? null : layout[0];
    }
    : discriminator
  ) as (encoded: Uint8Array) => B extends false ? LayoutIndex | null : readonly LayoutIndex[];
}
