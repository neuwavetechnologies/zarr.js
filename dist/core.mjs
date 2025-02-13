import { Buffer as Buffer$1 } from 'buffer';
import 'http2';
import { Readable, Writable, PassThrough, Duplex } from 'stream';
import { Agent, request as request$1 } from 'http';
import { Agent as Agent$1, request } from 'https';
import * as zlib from 'zlib';
import { promises, lstatSync, fstatSync } from 'fs';
import { createHash, createHmac } from 'crypto';
import { sep, join } from 'path';
import { homedir, platform, release } from 'os';
import { versions, env } from 'process';

const registry = new Map();
function addCodec(id, importFn) {
    registry.set(id, importFn);
}
async function getCodec(config) {
    if (!registry.has(config.id)) {
        throw new Error(`Compression codec ${config.id} is not supported by Zarr.js yet.`);
    }
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    const codec = await registry.get(config.id)();
    return codec.fromConfig(config);
}

function createProxy(mapping) {
    return new Proxy(mapping, {
        set(target, key, value, _receiver) {
            return target.setItem(key, value);
        },
        get(target, key, _receiver) {
            return target.getItem(key);
        },
        deleteProperty(target, key) {
            return target.deleteItem(key);
        },
        has(target, key) {
            return target.containsItem(key);
        }
    });
}

function isZarrError(err) {
    return typeof err === 'object' && err !== null && '__zarr__' in err;
}
function isKeyError(o) {
    return isZarrError(o) && o.__zarr__ === 'KeyError';
}
// Custom error messages, note we have to patch the prototype of the
// errors to fix `instanceof` calls, see:
// https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
class ContainsArrayError extends Error {
    constructor(path) {
        super(`path ${path} contains an array`);
        this.__zarr__ = 'ContainsArrayError';
        Object.setPrototypeOf(this, ContainsArrayError.prototype);
    }
}
class ContainsGroupError extends Error {
    constructor(path) {
        super(`path ${path} contains a group`);
        this.__zarr__ = 'ContainsGroupError';
        Object.setPrototypeOf(this, ContainsGroupError.prototype);
    }
}
class ArrayNotFoundError extends Error {
    constructor(path) {
        super(`array not found at path ${path}`);
        this.__zarr__ = 'ArrayNotFoundError';
        Object.setPrototypeOf(this, ArrayNotFoundError.prototype);
    }
}
class GroupNotFoundError extends Error {
    constructor(path) {
        super(`group not found at path ${path}`);
        this.__zarr__ = 'GroupNotFoundError';
        Object.setPrototypeOf(this, GroupNotFoundError.prototype);
    }
}
class PathNotFoundError extends Error {
    constructor(path) {
        super(`nothing found at path ${path}`);
        this.__zarr__ = 'PathNotFoundError';
        Object.setPrototypeOf(this, PathNotFoundError.prototype);
    }
}
class PermissionError extends Error {
    constructor(message) {
        super(message);
        this.__zarr__ = 'PermissionError';
        Object.setPrototypeOf(this, PermissionError.prototype);
    }
}
class KeyError extends Error {
    constructor(key) {
        super(`key ${key} not present`);
        this.__zarr__ = 'KeyError';
        Object.setPrototypeOf(this, KeyError.prototype);
    }
}
class TooManyIndicesError extends RangeError {
    constructor(selection, shape) {
        super(`too many indices for array; expected ${shape.length}, got ${selection.length}`);
        this.__zarr__ = 'TooManyIndicesError';
        Object.setPrototypeOf(this, TooManyIndicesError.prototype);
    }
}
class BoundsCheckError extends RangeError {
    constructor(message) {
        super(message);
        this.__zarr__ = 'BoundsCheckError';
        Object.setPrototypeOf(this, BoundsCheckError.prototype);
    }
}
class InvalidSliceError extends RangeError {
    constructor(from, to, stepSize, reason) {
        super(`slice arguments slice(${from}, ${to}, ${stepSize}) invalid: ${reason}`);
        this.__zarr__ = 'InvalidSliceError';
        Object.setPrototypeOf(this, InvalidSliceError.prototype);
    }
}
class NegativeStepError extends Error {
    constructor() {
        super(`Negative step size is not supported when indexing.`);
        this.__zarr__ = 'NegativeStepError';
        Object.setPrototypeOf(this, NegativeStepError.prototype);
    }
}
class ValueError extends Error {
    constructor(message) {
        super(message);
        this.__zarr__ = 'ValueError';
        Object.setPrototypeOf(this, ValueError.prototype);
    }
}
class HTTPError extends Error {
    constructor(code) {
        super(code);
        this.__zarr__ = 'HTTPError';
        Object.setPrototypeOf(this, HTTPError.prototype);
    }
}

function slice(start, stop = undefined, step = null) {
    // tslint:disable-next-line: strict-type-predicates
    if (start === undefined) { // Not possible in typescript
        throw new InvalidSliceError(start, stop, step, "The first argument must not be undefined");
    }
    if ((typeof start === "string" && start !== ":") || (typeof stop === "string" && stop !== ":")) { // Note in typescript this will never happen with type checking.
        throw new InvalidSliceError(start, stop, step, "Arguments can only be integers, \":\" or null");
    }
    // slice(5) === slice(null, 5)
    if (stop === undefined) {
        stop = start;
        start = null;
    }
    // if (start !== null && stop !== null && start > stop) {
    //     throw new InvalidSliceError(start, stop, step, "to is higher than from");
    // }
    return {
        start: start === ":" ? null : start,
        stop: stop === ":" ? null : stop,
        step,
        _slice: true,
    };
}
/**
 * Port of adjustIndices
 * https://github.com/python/cpython/blob/master/Objects/sliceobject.c#L243
 */
function adjustIndices(start, stop, step, length) {
    if (start < 0) {
        start += length;
        if (start < 0) {
            start = (step < 0) ? -1 : 0;
        }
    }
    else if (start >= length) {
        start = (step < 0) ? length - 1 : length;
    }
    if (stop < 0) {
        stop += length;
        if (stop < 0) {
            stop = (step < 0) ? -1 : 0;
        }
    }
    else if (stop >= length) {
        stop = (step < 0) ? length - 1 : length;
    }
    if (step < 0) {
        if (stop < start) {
            const length = Math.floor((start - stop - 1) / (-step) + 1);
            return [start, stop, step, length];
        }
    }
    else {
        if (start < stop) {
            const length = Math.floor((stop - start - 1) / step + 1);
            return [start, stop, step, length];
        }
    }
    return [start, stop, step, 0];
}
/**
 * Port of slice.indices(n) and PySlice_Unpack
 * https://github.com/python/cpython/blob/master/Objects/sliceobject.c#L166
 *  https://github.com/python/cpython/blob/master/Objects/sliceobject.c#L198
 *
 * Behaviour might be slightly different as it's a weird hybrid implementation.
 */
function sliceIndices(slice, length) {
    let start;
    let stop;
    let step;
    if (slice.step === null) {
        step = 1;
    }
    else {
        step = slice.step;
    }
    if (slice.start === null) {
        start = step < 0 ? Number.MAX_SAFE_INTEGER : 0;
    }
    else {
        start = slice.start;
        if (start < 0) {
            start += length;
        }
    }
    if (slice.stop === null) {
        stop = step < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    }
    else {
        stop = slice.stop;
        if (stop < 0) {
            stop += length;
        }
    }
    // This clips out of bounds slices
    const s = adjustIndices(start, stop, step, length);
    start = s[0];
    stop = s[1];
    step = s[2];
    // The output length
    length = s[3];
    // With out of bounds slicing these two assertions are not useful.
    // if (stop > length) throw new Error("Stop greater than length");
    // if (start >= length) throw new Error("Start greater than or equal to length");
    if (step === 0)
        throw new Error("Step size 0 is invalid");
    return [start, stop, step, length];
}

function ensureArray(selection) {
    if (!Array.isArray(selection)) {
        return [selection];
    }
    return selection;
}
function checkSelectionLength(selection, shape) {
    if (selection.length > shape.length) {
        throw new TooManyIndicesError(selection, shape);
    }
}
/**
 * Returns both the sliceIndices per dimension and the output shape after slicing.
 */
function selectionToSliceIndices(selection, shape) {
    const sliceIndicesResult = [];
    const outShape = [];
    for (let i = 0; i < selection.length; i++) {
        const s = selection[i];
        if (typeof s === "number") {
            sliceIndicesResult.push(s);
        }
        else {
            const x = sliceIndices(s, shape[i]);
            const dimLength = x[3];
            outShape.push(dimLength);
            sliceIndicesResult.push(x);
        }
    }
    return [sliceIndicesResult, outShape];
}
/**
 * This translates "...", ":", null into a list of slices or non-negative integer selections of length shape
 */
function normalizeArraySelection(selection, shape, convertIntegerSelectionToSlices = false) {
    selection = replaceEllipsis(selection, shape);
    for (let i = 0; i < selection.length; i++) {
        const dimSelection = selection[i];
        if (typeof dimSelection === "number") {
            if (convertIntegerSelectionToSlices) {
                selection[i] = slice(dimSelection, dimSelection + 1, 1);
            }
            else {
                selection[i] = normalizeIntegerSelection(dimSelection, shape[i]);
            }
        }
        else if (isIntegerArray(dimSelection)) {
            throw new TypeError("Integer array selections are not supported (yet)");
        }
        else if (dimSelection === ":" || dimSelection === null) {
            selection[i] = slice(null, null, 1);
        }
    }
    return selection;
}
function replaceEllipsis(selection, shape) {
    selection = ensureArray(selection);
    let ellipsisIndex = -1;
    let numEllipsis = 0;
    for (let i = 0; i < selection.length; i++) {
        if (selection[i] === "...") {
            ellipsisIndex = i;
            numEllipsis += 1;
        }
    }
    if (numEllipsis > 1) {
        throw new RangeError("an index can only have a single ellipsis ('...')");
    }
    if (numEllipsis === 1) {
        // count how many items to left and right of ellipsis
        const numItemsLeft = ellipsisIndex;
        const numItemsRight = selection.length - (numItemsLeft + 1);
        const numItems = selection.length - 1; // All non-ellipsis items
        if (numItems >= shape.length) {
            // Ellipsis does nothing, just remove it
            selection = selection.filter((x) => x !== "...");
        }
        else {
            // Replace ellipsis with as many slices are needed for number of dims
            const numNewItems = shape.length - numItems;
            let newItem = selection.slice(0, numItemsLeft).concat(new Array(numNewItems).fill(null));
            if (numItemsRight > 0) {
                newItem = newItem.concat(selection.slice(selection.length - numItemsRight));
            }
            selection = newItem;
        }
    }
    // Fill out selection if not completely specified
    if (selection.length < shape.length) {
        const numMissing = shape.length - selection.length;
        selection = selection.concat(new Array(numMissing).fill(null));
    }
    checkSelectionLength(selection, shape);
    return selection;
}
function normalizeIntegerSelection(dimSelection, dimLength) {
    // Note: Maybe we should convert to integer or warn if dimSelection is not an integer
    // handle wraparound
    if (dimSelection < 0) {
        dimSelection = dimLength + dimSelection;
    }
    // handle out of bounds
    if (dimSelection >= dimLength || dimSelection < 0) {
        throw new BoundsCheckError(`index out of bounds for dimension with length ${dimLength}`);
    }
    return dimSelection;
}
function isInteger(s) {
    return typeof s === "number";
}
function isIntegerArray(s) {
    if (!Array.isArray(s)) {
        return false;
    }
    for (const e of s) {
        if (typeof e !== "number") {
            return false;
        }
    }
    return true;
}
function isSlice(s) {
    if (s !== null && s["_slice"] === true) {
        return true;
    }
    return false;
}
function isContiguousSlice(s) {
    return isSlice(s) && (s.step === null || s.step === 1);
}
function isContiguousSelection(selection) {
    selection = ensureArray(selection);
    for (let i = 0; i < selection.length; i++) {
        const s = selection[i];
        if (!(isIntegerArray(s) || isContiguousSlice(s) || s === "...")) {
            return false;
        }
    }
    return true;
}
function* product(...iterables) {
    if (iterables.length === 0) {
        return;
    }
    // make a list of iterators from the iterables
    const iterators = iterables.map(it => it());
    const results = iterators.map(it => it.next());
    // Disabled to allow empty inputs
    // if (results.some(r => r.done)) {
    //     throw new Error("Input contains an empty iterator.");
    // }
    for (let i = 0;;) {
        if (results[i].done) {
            // reset the current iterator
            iterators[i] = iterables[i]();
            results[i] = iterators[i].next();
            // advance, and exit if we've reached the end
            if (++i >= iterators.length) {
                return;
            }
        }
        else {
            yield results.map(({ value }) => value);
            i = 0;
        }
        results[i] = iterators[i].next();
    }
}
class BasicIndexer {
    constructor(selection, array) {
        selection = normalizeArraySelection(selection, array.shape);
        // Setup per-dimension indexers
        this.dimIndexers = [];
        const arrayShape = array.shape;
        for (let i = 0; i < arrayShape.length; i++) {
            let dimSelection = selection[i];
            const dimLength = arrayShape[i];
            const dimChunkLength = array.chunks[i];
            if (dimSelection === null) {
                dimSelection = slice(null);
            }
            if (isInteger(dimSelection)) {
                this.dimIndexers.push(new IntDimIndexer(dimSelection, dimLength, dimChunkLength));
            }
            else if (isSlice(dimSelection)) {
                this.dimIndexers.push(new SliceDimIndexer(dimSelection, dimLength, dimChunkLength));
            }
            else {
                throw new RangeError(`Unspported selection item for basic indexing; expected integer or slice, got ${dimSelection}`);
            }
        }
        this.shape = [];
        for (const d of this.dimIndexers) {
            if (d instanceof SliceDimIndexer) {
                this.shape.push(d.numItems);
            }
        }
        this.dropAxes = null;
    }
    *iter() {
        const dimIndexerIterables = this.dimIndexers.map(x => (() => x.iter()));
        const dimIndexerProduct = product(...dimIndexerIterables);
        for (const dimProjections of dimIndexerProduct) {
            // TODO fix this, I think the product outputs too many combinations
            const chunkCoords = [];
            const chunkSelection = [];
            const outSelection = [];
            for (const p of dimProjections) {
                chunkCoords.push((p).dimChunkIndex);
                chunkSelection.push((p).dimChunkSelection);
                if ((p).dimOutSelection !== null) {
                    outSelection.push((p).dimOutSelection);
                }
            }
            yield {
                chunkCoords,
                chunkSelection,
                outSelection,
            };
        }
    }
}
class IntDimIndexer {
    constructor(dimSelection, dimLength, dimChunkLength) {
        dimSelection = normalizeIntegerSelection(dimSelection, dimLength);
        this.dimSelection = dimSelection;
        this.dimLength = dimLength;
        this.dimChunkLength = dimChunkLength;
        this.numItems = 1;
    }
    *iter() {
        const dimChunkIndex = Math.floor(this.dimSelection / this.dimChunkLength);
        const dimOffset = dimChunkIndex * this.dimChunkLength;
        const dimChunkSelection = this.dimSelection - dimOffset;
        const dimOutSelection = null;
        yield {
            dimChunkIndex,
            dimChunkSelection,
            dimOutSelection,
        };
    }
}
class SliceDimIndexer {
    constructor(dimSelection, dimLength, dimChunkLength) {
        // Normalize
        const [start, stop, step] = sliceIndices(dimSelection, dimLength);
        this.start = start;
        this.stop = stop;
        this.step = step;
        if (this.step < 1) {
            throw new NegativeStepError();
        }
        this.dimLength = dimLength;
        this.dimChunkLength = dimChunkLength;
        this.numItems = Math.max(0, Math.ceil((this.stop - this.start) / this.step));
        this.numChunks = Math.ceil(this.dimLength / this.dimChunkLength);
    }
    *iter() {
        const dimChunkIndexFrom = Math.floor(this.start / this.dimChunkLength);
        const dimChunkIndexTo = Math.ceil(this.stop / this.dimChunkLength);
        // Iterate over chunks in range
        for (let dimChunkIndex = dimChunkIndexFrom; dimChunkIndex < dimChunkIndexTo; dimChunkIndex++) {
            // Compute offsets for chunk within overall array
            const dimOffset = dimChunkIndex * this.dimChunkLength;
            const dimLimit = Math.min(this.dimLength, (dimChunkIndex + 1) * this.dimChunkLength);
            // Determine chunk length, accounting for trailing chunk
            const dimChunkLength = dimLimit - dimOffset;
            let dimChunkSelStart;
            let dimChunkSelStop;
            let dimOutOffset;
            if (this.start < dimOffset) {
                // Selection starts before current chunk
                dimChunkSelStart = 0;
                const remainder = (dimOffset - this.start) % this.step;
                if (remainder > 0) {
                    dimChunkSelStart += this.step - remainder;
                }
                // Compute number of previous items, provides offset into output array
                dimOutOffset = Math.ceil((dimOffset - this.start) / this.step);
            }
            else {
                // Selection starts within current chunk
                dimChunkSelStart = this.start - dimOffset;
                dimOutOffset = 0;
            }
            if (this.stop > dimLimit) {
                // Selection ends after current chunk
                dimChunkSelStop = dimChunkLength;
            }
            else {
                // Selection ends within current chunk
                dimChunkSelStop = this.stop - dimOffset;
            }
            const dimChunkSelection = slice(dimChunkSelStart, dimChunkSelStop, this.step);
            const dimChunkNumItems = Math.ceil((dimChunkSelStop - dimChunkSelStart) / this.step);
            const dimOutSelection = slice(dimOutOffset, dimOutOffset + dimChunkNumItems);
            yield {
                dimChunkIndex,
                dimChunkSelection,
                dimOutSelection,
            };
        }
    }
}

/**
 * This should be true only if this javascript is getting executed in Node.
 */
const IS_NODE = typeof process !== "undefined" && process.versions && process.versions.node;
// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop() { }
// eslint-disable-next-line @typescript-eslint/ban-types
function normalizeStoragePath(path) {
    if (path === null) {
        return "";
    }
    if (path instanceof String) {
        path = path.valueOf();
    }
    // convert backslash to forward slash
    path = path.replace(/\\/g, "/");
    // ensure no leading slash
    while (path.length > 0 && path[0] === '/') {
        path = path.slice(1);
    }
    // ensure no trailing slash
    while (path.length > 0 && path[path.length - 1] === '/') {
        path = path.slice(0, path.length - 1);
    }
    // collapse any repeated slashes
    path = path.replace(/\/\/+/g, "/");
    // don't allow path segments with just '.' or '..'
    const segments = path.split('/');
    for (const s of segments) {
        if (s === "." || s === "..") {
            throw Error("path containing '.' or '..' segment not allowed");
        }
    }
    return path;
}
function normalizeShape(shape) {
    if (typeof shape === "number") {
        shape = [shape];
    }
    return shape.map(x => Math.floor(x));
}
function normalizeChunks(chunks, shape) {
    // Assume shape is already normalized
    if (chunks === null || chunks === true) {
        throw new Error("Chunk guessing is not supported yet");
    }
    if (chunks === false) {
        return shape;
    }
    if (typeof chunks === "number") {
        chunks = [chunks];
    }
    // handle underspecified chunks
    if (chunks.length < shape.length) {
        // assume chunks across remaining dimensions
        chunks = chunks.concat(shape.slice(chunks.length));
    }
    return chunks.map((x, idx) => {
        // handle null or -1 in chunks
        if (x === -1 || x === null) {
            return shape[idx];
        }
        else {
            return Math.floor(x);
        }
    });
}
function normalizeOrder(order) {
    order = order.toUpperCase();
    return order;
}
function normalizeDtype(dtype) {
    return dtype;
}
function normalizeFillValue(fillValue) {
    return fillValue;
}
/**
 * Determine whether `item` specifies a complete slice of array with the
 *  given `shape`. Used to optimize __setitem__ operations on chunks
 * @param item
 * @param shape
 */
function isTotalSlice(item, shape) {
    if (item === null) {
        return true;
    }
    if (!Array.isArray(item)) {
        item = [item];
    }
    for (let i = 0; i < Math.min(item.length, shape.length); i++) {
        const it = item[i];
        if (it === null)
            continue;
        if (isSlice(it)) {
            const s = it;
            const isStepOne = s.step === 1 || s.step === null;
            if (s.start === null && s.stop === null && isStepOne) {
                continue;
            }
            if ((s.stop - s.start) === shape[i] && isStepOne) {
                continue;
            }
            return false;
        }
        return false;
        // } else {
        //     console.error(`isTotalSlice unexpected non-slice, got ${it}`);
        //     return false;
        // }
    }
    return true;
}
/**
 * Checks for === equality of all elements.
 */
function arrayEquals1D(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
/*
 * Determines "C" order strides for a given shape array.
 * Strides provide integer steps in each dimention to traverse an ndarray.
 *
 * NOTE: - These strides here are distinct from numpy.ndarray.strides, which describe actual byte steps.
 *       - Strides are assumed to be contiguous, so initial step is 1. Thus, output will always be [XX, XX, 1].
 */
function getStrides(shape) {
    // adapted from https://github.com/scijs/ndarray/blob/master/ndarray.js#L326-L330
    const ndim = shape.length;
    const strides = Array(ndim);
    let step = 1; // init step
    for (let i = ndim - 1; i >= 0; i--) {
        strides[i] = step;
        step *= shape[i];
    }
    return strides;
}
function resolveUrl(root, path) {
    const base = typeof root === 'string' ? new URL(root) : root;
    if (!base.pathname.endsWith('/')) {
        // ensure trailing slash so that base is resolved as _directory_
        base.pathname += '/';
    }
    const resolved = new URL(path, base);
    // copy search params to new URL
    resolved.search = base.search;
    return resolved.href;
}
/**
 * Swaps byte order in-place for a given TypedArray.
 * Used to flip endian-ness when getting/setting chunks from/to zarr store.
 * @param src TypedArray
 */
function byteSwapInplace(src) {
    const b = src.BYTES_PER_ELEMENT;
    if (b === 1)
        return; // no swapping needed
    if (IS_NODE) {
        // Use builtin methods for swapping if in Node environment
        const bytes = Buffer.from(src.buffer, src.byteOffset, src.length * b);
        if (b === 2)
            bytes.swap16();
        if (b === 4)
            bytes.swap32();
        if (b === 8)
            bytes.swap64();
        return;
    }
    // In browser, need to flip manually
    // Adapted from https://github.com/zbjornson/node-bswap/blob/master/bswap.js
    const flipper = new Uint8Array(src.buffer, src.byteOffset, src.length * b);
    const numFlips = b / 2;
    const endByteIndex = b - 1;
    let t;
    for (let i = 0; i < flipper.length; i += b) {
        for (let j = 0; j < numFlips; j++) {
            t = flipper[i + j];
            flipper[i + j] = flipper[i + endByteIndex - j];
            flipper[i + endByteIndex - j] = t;
        }
    }
}
/**
 * Creates a copy of a TypedArray and swaps bytes.
 * Used to flip endian-ness when getting/setting chunks from/to zarr store.
 * @param src TypedArray
 */
function byteSwap(src) {
    const copy = src.slice();
    byteSwapInplace(copy);
    return copy;
}
function convertColMajorToRowMajor2D(src, out, shape) {
    let idx = 0;
    const shape0 = shape[0];
    const shape1 = shape[1];
    const stride0 = shape1;
    for (let i1 = 0; i1 < shape1; i1++) {
        for (let i0 = 0; i0 < shape0; i0++) {
            out[i0 * stride0 + i1] = src[idx++];
        }
    }
}
function convertColMajorToRowMajor3D(src, out, shape) {
    let idx = 0;
    const shape0 = shape[0];
    const shape1 = shape[1];
    const shape2 = shape[2];
    const stride0 = shape2 * shape1;
    const stride1 = shape2;
    for (let i2 = 0; i2 < shape2; i2++) {
        for (let i1 = 0; i1 < shape1; i1++) {
            for (let i0 = 0; i0 < shape0; i0++) {
                out[i0 * stride0 + i1 * stride1 + i2] = src[idx++];
            }
        }
    }
}
function convertColMajorToRowMajor4D(src, out, shape) {
    let idx = 0;
    const shape0 = shape[0];
    const shape1 = shape[1];
    const shape2 = shape[2];
    const shape3 = shape[3];
    const stride0 = shape3 * shape2 * shape1;
    const stride1 = shape3 * shape2;
    const stride2 = shape3;
    for (let i3 = 0; i3 < shape3; i3++) {
        for (let i2 = 0; i2 < shape2; i2++) {
            for (let i1 = 0; i1 < shape1; i1++) {
                for (let i0 = 0; i0 < shape0; i0++) {
                    out[i0 * stride0 + i1 * stride1 + i2 * stride2 + i3] = src[idx++];
                }
            }
        }
    }
}
function convertColMajorToRowMajorGeneric(src, out, shape) {
    const nDims = shape.length;
    const size = shape.reduce((r, a) => r * a);
    const rowMajorStrides = shape.map((_, i) => i + 1 === nDims ? 1 : shape.slice(i + 1).reduce((r, a) => r * a, 1));
    const index = Array(nDims).fill(0);
    for (let colMajorIdx = 0; colMajorIdx < size; colMajorIdx++) {
        let rowMajorIdx = 0;
        for (let dim = 0; dim < nDims; dim++) {
            rowMajorIdx += index[dim] * rowMajorStrides[dim];
        }
        out[rowMajorIdx] = src[colMajorIdx];
        index[0] += 1;
        // Handle carry-over
        for (let dim = 0; dim < nDims; dim++) {
            if (index[dim] === shape[dim]) {
                if (dim + 1 === nDims) {
                    return;
                }
                index[dim] = 0;
                index[dim + 1] += 1;
            }
        }
    }
}
const colMajorToRowMajorConverters = {
    [0]: noop,
    [1]: noop,
    [2]: convertColMajorToRowMajor2D,
    [3]: convertColMajorToRowMajor3D,
    [4]: convertColMajorToRowMajor4D,
};
/**
 * Rewrites a copy of a TypedArray while converting it from column-major (F-order) to row-major (C-order).
 * @param src TypedArray
 * @param out TypedArray
 * @param shape number[]
 */
function convertColMajorToRowMajor(src, out, shape) {
    return (colMajorToRowMajorConverters[shape.length] || convertColMajorToRowMajorGeneric)(src, out, shape);
}
function isArrayBufferLike(obj) {
    if (obj === null) {
        return false;
    }
    if (obj instanceof ArrayBuffer) {
        return true;
    }
    if (typeof SharedArrayBuffer === "function" && obj instanceof SharedArrayBuffer) {
        return true;
    }
    if (IS_NODE) { // Necessary for Node.js for some reason..
        return obj.toString().startsWith("[object ArrayBuffer]")
            || obj.toString().startsWith("[object SharedArrayBuffer]");
    }
    return false;
}

const ARRAY_META_KEY = ".zarray";
// export const GROUP_META_KEY = ".zgroup";
const GROUP_META_KEY = ".zmetadata";
const ATTRS_META_KEY = ".zattrs";

/**
 * Return true if the store contains an array at the given logical path.
 */
async function containsArray(store, path = null) {
    path = normalizeStoragePath(path);
    const prefix = pathToPrefix(path);
    const key = prefix + ARRAY_META_KEY;
    return store.containsItem(key);
}
/**
 * Return true if the store contains a group at the given logical path.
 */
async function containsGroup(store, path = null) {
    path = normalizeStoragePath(path);
    const prefix = pathToPrefix(path);
    const key = prefix + GROUP_META_KEY;
    return store.containsItem(key);
}
function pathToPrefix(path) {
    // assume path already normalized
    if (path.length > 0) {
        return path + '/';
    }
    return '';
}
async function requireParentGroup(store, path, chunkStore, overwrite) {
    // Assume path is normalized
    if (path.length === 0) {
        return;
    }
    const segments = path.split("/");
    let p = "";
    for (const s of segments.slice(0, segments.length - 1)) {
        p += s;
        if (await containsArray(store, p)) {
            await initGroupMetadata(store, p, overwrite);
        }
        else if (!await containsGroup(store, p)) {
            await initGroupMetadata(store, p);
        }
        p += "/";
    }
}
async function initGroupMetadata(store, path = null, overwrite = false) {
    path = normalizeStoragePath(path);
    // Guard conditions
    if (overwrite) {
        throw Error("Group overwriting not implemented yet :(");
    }
    else if (await containsArray(store, path)) {
        throw new ContainsArrayError(path);
    }
    else if (await containsGroup(store, path)) {
        throw new ContainsGroupError(path);
    }
    const metadata = { zarr_format: 2 };
    const key = pathToPrefix(path) + GROUP_META_KEY;
    await store.setItem(key, JSON.stringify(metadata));
}
/**
 *  Initialize a group store. Note that this is a low-level function and there should be no
 *  need to call this directly from user code.
 */
async function initGroup(store, path = null, chunkStore = null, overwrite = false) {
    path = normalizeStoragePath(path);
    await requireParentGroup(store, path, chunkStore, overwrite);
    await initGroupMetadata(store, path, overwrite);
}
async function initArrayMetadata(store, shape, chunks, dtype, path, compressor, fillValue, order, overwrite, chunkStore, filters, dimensionSeparator) {
    // Guard conditions
    if (overwrite) {
        throw Error("Array overwriting not implemented yet :(");
    }
    else if (await containsArray(store, path)) {
        throw new ContainsArrayError(path);
    }
    else if (await containsGroup(store, path)) {
        throw new ContainsGroupError(path);
    }
    // Normalize metadata,  does type checking too.
    dtype = normalizeDtype(dtype);
    shape = normalizeShape(shape);
    chunks = normalizeChunks(chunks, shape);
    order = normalizeOrder(order);
    fillValue = normalizeFillValue(fillValue);
    if (filters !== null && filters.length > 0) {
        throw Error("Filters are not supported yet");
    }
    let serializedFillValue = fillValue;
    if (typeof fillValue === "number") {
        if (Number.isNaN(fillValue))
            serializedFillValue = "NaN";
        if (Number.POSITIVE_INFINITY === fillValue)
            serializedFillValue = "Infinity";
        if (Number.NEGATIVE_INFINITY === fillValue)
            serializedFillValue = "-Infinity";
    }
    filters = null;
    const metadata = {
        zarr_format: 2,
        shape: shape,
        chunks: chunks,
        dtype: dtype,
        fill_value: serializedFillValue,
        order: order,
        compressor: compressor,
        filters: filters,
    };
    if (dimensionSeparator) {
        metadata.dimension_separator = dimensionSeparator;
    }
    const metaKey = pathToPrefix(path) + ARRAY_META_KEY;
    await store.setItem(metaKey, JSON.stringify(metadata));
}
/**
 *
 * Initialize an array store with the given configuration. Note that this is a low-level
 * function and there should be no need to call this directly from user code
 */
async function initArray(store, shape, chunks, dtype, path = null, compressor = null, fillValue = null, order = "C", overwrite = false, chunkStore = null, filters = null, dimensionSeparator) {
    path = normalizeStoragePath(path);
    await requireParentGroup(store, path, chunkStore, overwrite);
    await initArrayMetadata(store, shape, chunks, dtype, path, compressor, fillValue, order, overwrite, chunkStore, filters, dimensionSeparator);
}

function parseMetadata(s) {
    // Here we allow that a store may return an already-parsed metadata object,
    // or a string of JSON that we will parse here. We allow for an already-parsed
    // object to accommodate a consolidated metadata store, where all the metadata for
    // all groups and arrays will already have been parsed from JSON.
    if (typeof s !== 'string') {
        // tslint:disable-next-line: strict-type-predicates
        if (IS_NODE && Buffer.isBuffer(s)) {
            return JSON.parse(s.toString());
        }
        else if (isArrayBufferLike(s)) {
            const utf8Decoder = new TextDecoder();
            const bytes = new Uint8Array(s);
            return JSON.parse(utf8Decoder.decode(bytes));
        }
        else {
            return s;
        }
    }
    return JSON.parse(s);
}

/**
 * Class providing access to user attributes on an array or group. Should not be
 * instantiated directly, will be available via the `.attrs` property of an array or
 * group.
 */
class Attributes {
    constructor(store, key, readOnly, cache = true) {
        this.store = store;
        this.key = key;
        this.readOnly = readOnly;
        this.cache = cache;
        this.cachedValue = null;
    }
    /**
     * Retrieve all attributes as a JSON object.
     */
    async asObject() {
        if (this.cache && this.cachedValue !== null) {
            return this.cachedValue;
        }
        const o = await this.getNoSync();
        if (this.cache) {
            this.cachedValue = o;
        }
        return o;
    }
    async getNoSync() {
        try {
            const data = await this.store.getItem(this.key);
            // TODO fix typing?
            return parseMetadata(data);
        }
        catch (error) {
            return {};
        }
    }
    async setNoSync(key, value) {
        const d = await this.getNoSync();
        d[key] = value;
        await this.putNoSync(d);
        return true;
    }
    async putNoSync(m) {
        await this.store.setItem(this.key, JSON.stringify(m));
        if (this.cache) {
            this.cachedValue = m;
        }
    }
    async delNoSync(key) {
        const d = await this.getNoSync();
        delete d[key];
        await this.putNoSync(d);
        return true;
    }
    /**
     * Overwrite all attributes with the provided object in a single operation
     */
    async put(d) {
        if (this.readOnly) {
            throw new PermissionError("attributes are read-only");
        }
        return this.putNoSync(d);
    }
    async setItem(key, value) {
        if (this.readOnly) {
            throw new PermissionError("attributes are read-only");
        }
        return this.setNoSync(key, value);
    }
    async getItem(key) {
        return (await this.asObject())[key];
    }
    async deleteItem(key) {
        if (this.readOnly) {
            throw new PermissionError("attributes are read-only");
        }
        return this.delNoSync(key);
    }
    async containsItem(key) {
        return (await this.asObject())[key] !== undefined;
    }
    proxy() {
        return createProxy(this);
    }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const Float16Array = globalThis.Float16Array;
const DTYPE_TYPEDARRAY_MAPPING = {
    '|b': Int8Array,
    '|b1': Uint8Array,
    '|B': Uint8Array,
    '|u1': Uint8Array,
    '|i1': Int8Array,
    '<b': Int8Array,
    '<B': Uint8Array,
    '<u1': Uint8Array,
    '<i1': Int8Array,
    '<u2': Uint16Array,
    '<i2': Int16Array,
    '<u4': Uint32Array,
    '<i4': Int32Array,
    '<i8': Float64Array,
    '<f2': Float16Array,
    '<f4': Float32Array,
    '<f8': Float64Array,
    '>b': Int8Array,
    '>B': Uint8Array,
    '>u1': Uint8Array,
    '>i1': Int8Array,
    '>u2': Uint16Array,
    '>i2': Int16Array,
    '>u4': Uint32Array,
    '>i4': Int32Array,
    '>f4': Float32Array,
    '>f2': Float16Array,
    '>f8': Float64Array
};
function getTypedArrayCtr(dtype) {
    const ctr = DTYPE_TYPEDARRAY_MAPPING[dtype];
    if (!ctr) {
        if (dtype.slice(1) === 'f2') {
            throw Error(`'${dtype}' is not supported natively in zarr.js. ` +
                `In order to access this dataset you must make Float16Array available as a global. ` +
                `See https://github.com/gzuidhof/zarr.js/issues/127`);
        }
        throw Error(`Dtype not recognized or not supported in zarr.js, got ${dtype}.`);
    }
    return ctr;
}
/*
 * Called by NestedArray and RawArray constructors only.
 * We byte-swap the buffer of a store after decoding
 * since TypedArray views are little endian only.
 *
 * This means NestedArrays and RawArrays will always be little endian,
 * unless a numpy-like library comes around and can handle endianess
 * for buffer views.
 */
function getTypedArrayDtypeString(t) {
    // Favour the types below instead of small and big B
    if (t instanceof Uint8Array)
        return '|u1';
    if (t instanceof Int8Array)
        return '|i1';
    if (t instanceof Uint16Array)
        return '<u2';
    if (t instanceof Int16Array)
        return '<i2';
    if (t instanceof Uint32Array)
        return '<u4';
    if (t instanceof Int32Array)
        return '<i4';
    // if (t instanceof Float64Array) return '<i8';
    if (t instanceof Float32Array)
        return '<f4';
    if (t instanceof Float64Array)
        return '<f8';
    throw new ValueError('Mapping for TypedArray to Dtypestring not known');
}

/**
 * Digs down into the dimensions of given array to find the TypedArray and returns its constructor.
 * Better to use sparingly.
 */
function getNestedArrayConstructor(arr) {
    // TODO fix typing
    // tslint:disable-next-line: strict-type-predicates
    if (arr.byteLength !== undefined) {
        return (arr).constructor;
    }
    return getNestedArrayConstructor(arr[0]);
}
/**
 * Returns both the slice result and new output shape
 * @param arr NestedArray to slice
 * @param shape The shape of the NestedArray
 * @param selection
 */
function sliceNestedArray(arr, shape, selection) {
    // This translates "...", ":", null into a list of slices or integer selections
    const normalizedSelection = normalizeArraySelection(selection, shape);
    const [sliceIndices, outShape] = selectionToSliceIndices(normalizedSelection, shape);
    const outArray = _sliceNestedArray(arr, shape, sliceIndices);
    return [outArray, outShape];
}
function _sliceNestedArray(arr, shape, selection) {
    const currentSlice = selection[0];
    // Is this necessary?
    // // This is possible when a slice list is passed shorter than the amount of dimensions
    // // tslint:disable-next-line: strict-type-predicates
    // if (currentSlice === undefined) {
    //     return arr.slice();
    // }
    // When a number is passed that dimension is squeezed
    if (typeof currentSlice === "number") {
        // Assume already normalized integer selection here.
        if (shape.length === 1) {
            return arr[currentSlice];
        }
        else {
            return _sliceNestedArray(arr[currentSlice], shape.slice(1), selection.slice(1));
        }
    }
    const [from, to, step, outputSize] = currentSlice;
    if (outputSize === 0) {
        return new (getNestedArrayConstructor(arr))(0);
    }
    if (shape.length === 1) {
        if (step === 1) {
            return arr.slice(from, to);
        }
        const newArrData = new arr.constructor(outputSize);
        for (let i = 0; i < outputSize; i++) {
            newArrData[i] = arr[from + i * step];
        }
        return newArrData;
    }
    let newArr = new Array(outputSize);
    for (let i = 0; i < outputSize; i++) {
        newArr[i] = _sliceNestedArray(arr[from + i * step], shape.slice(1), selection.slice(1));
    }
    // This is necessary to ensure that the return value is a NestedArray if the last dimension is squeezed
    // e.g. shape [2,1] with slice [:, 0] would otherwise result in a list of numbers instead of a valid NestedArray
    if (outputSize > 0 && typeof newArr[0] === "number") {
        const typedArrayConstructor = arr[0].constructor;
        newArr = typedArrayConstructor.from(newArr);
    }
    return newArr;
}
function setNestedArrayToScalar(dstArr, value, destShape, selection) {
    // This translates "...", ":", null, etc into a list of slices.
    const normalizedSelection = normalizeArraySelection(selection, destShape, true);
    // Above we force the results to be SliceIndicesIndices only, without integer selections making this cast is safe.
    const [sliceIndices, _outShape] = selectionToSliceIndices(normalizedSelection, destShape);
    _setNestedArrayToScalar(dstArr, value, destShape, sliceIndices);
}
function setNestedArray(dstArr, sourceArr, destShape, sourceShape, selection) {
    // This translates "...", ":", null, etc into a list of slices.
    const normalizedSelection = normalizeArraySelection(selection, destShape, false);
    const [sliceIndices, outShape] = selectionToSliceIndices(normalizedSelection, destShape);
    // TODO: replace with non stringify equality check
    if (JSON.stringify(outShape) !== JSON.stringify(sourceShape)) {
        throw new ValueError(`Shape mismatch in target and source NestedArray: ${outShape} and ${sourceShape}`);
    }
    _setNestedArray(dstArr, sourceArr, destShape, sliceIndices);
}
function _setNestedArray(dstArr, sourceArr, shape, selection) {
    const currentSlice = selection[0];
    if (typeof sourceArr === "number") {
        _setNestedArrayToScalar(dstArr, sourceArr, shape, selection.map(x => typeof x === "number" ? [x, x + 1, 1, 1] : x));
        return;
    }
    // This dimension is squeezed.
    if (typeof currentSlice === "number") {
        _setNestedArray(dstArr[currentSlice], sourceArr, shape.slice(1), selection.slice(1));
        return;
    }
    const [from, _to, step, outputSize] = currentSlice;
    if (shape.length === 1) {
        if (step === 1) {
            dstArr.set(sourceArr, from);
        }
        else {
            for (let i = 0; i < outputSize; i++) {
                dstArr[from + i * step] = (sourceArr)[i];
            }
        }
        return;
    }
    for (let i = 0; i < outputSize; i++) {
        _setNestedArray(dstArr[from + i * step], sourceArr[i], shape.slice(1), selection.slice(1));
    }
}
function _setNestedArrayToScalar(dstArr, value, shape, selection) {
    const currentSlice = selection[0];
    const [from, to, step, outputSize] = currentSlice;
    if (shape.length === 1) {
        if (step === 1) {
            dstArr.fill(value, from, to);
        }
        else {
            for (let i = 0; i < outputSize; i++) {
                dstArr[from + i * step] = value;
            }
        }
        return;
    }
    for (let i = 0; i < outputSize; i++) {
        _setNestedArrayToScalar(dstArr[from + i * step], value, shape.slice(1), selection.slice(1));
    }
}
function flattenNestedArray(arr, shape, constr) {
    if (constr === undefined) {
        constr = getNestedArrayConstructor(arr);
    }
    const size = shape.reduce((x, y) => x * y, 1);
    const outArr = new constr(size);
    _flattenNestedArray(arr, shape, outArr, 0);
    return outArr;
}
function _flattenNestedArray(arr, shape, outArr, offset) {
    if (shape.length === 1) {
        // This is only ever reached if called with rank 1 shape, never reached through recursion.
        // We just slice set the array directly from one level above to save some function calls.
        outArr.set(arr, offset);
        return;
    }
    if (shape.length === 2) {
        for (let i = 0; i < shape[0]; i++) {
            outArr.set(arr[i], offset + shape[1] * i);
        }
        return arr;
    }
    const nextShape = shape.slice(1);
    // Small optimization possible here: this can be precomputed for different levels of depth and passed on.
    const mult = nextShape.reduce((x, y) => x * y, 1);
    for (let i = 0; i < shape[0]; i++) {
        _flattenNestedArray(arr[i], nextShape, outArr, offset + mult * i);
    }
    return arr;
}

class NestedArray {
    constructor(data, shape, dtype) {
        const dataIsTypedArray = data !== null && !!data.BYTES_PER_ELEMENT;
        if (shape === undefined) {
            if (!dataIsTypedArray) {
                throw new ValueError("Shape argument is required unless you pass in a TypedArray");
            }
            shape = [data.length];
        }
        if (dtype === undefined) {
            if (!dataIsTypedArray) {
                throw new ValueError("Dtype argument is required unless you pass in a TypedArray");
            }
            dtype = getTypedArrayDtypeString(data);
        }
        shape = normalizeShape(shape);
        this.shape = shape;
        this.dtype = dtype;
        if (dataIsTypedArray && shape.length !== 1) {
            data = data.buffer;
        }
        // Zero dimension array.. they are a bit weirdly represented now, they will only ever occur internally
        if (this.shape.length === 0) {
            this.data = new (getTypedArrayCtr(dtype))(1);
        }
        else if (
        // tslint:disable-next-line: strict-type-predicates
        (IS_NODE && Buffer.isBuffer(data))
            || isArrayBufferLike(data)
            || data === null) {
            // Create from ArrayBuffer or Buffer
            const numShapeElements = shape.reduce((x, y) => x * y, 1);
            if (data === null) {
                data = new ArrayBuffer(numShapeElements * parseInt(dtype[dtype.length - 1], 10));
            }
            const numDataElements = data.byteLength / parseInt(dtype[dtype.length - 1], 10);
            if (numShapeElements !== numDataElements) {
                throw new Error(`Buffer has ${numDataElements} of dtype ${dtype}, shape is too large or small ${shape} (flat=${numShapeElements})`);
            }
            const typeConstructor = getTypedArrayCtr(dtype);
            this.data = createNestedArray(data, typeConstructor, shape);
        }
        else {
            this.data = data;
        }
    }
    get(selection) {
        const [sliceResult, outShape] = sliceNestedArray(this.data, this.shape, selection);
        if (outShape.length === 0) {
            return sliceResult;
        }
        else {
            return new NestedArray(sliceResult, outShape, this.dtype);
        }
    }
    set(selection = null, value) {
        if (selection === null) {
            selection = [slice(null)];
        }
        if (typeof value === "number") {
            if (this.shape.length === 0) {
                // Zero dimension array..
                this.data[0] = value;
            }
            else {
                setNestedArrayToScalar(this.data, value, this.shape, selection);
            }
        }
        else {
            setNestedArray(this.data, value.data, this.shape, value.shape, selection);
        }
    }
    flatten() {
        if (this.shape.length === 1) {
            return this.data;
        }
        return flattenNestedArray(this.data, this.shape, getTypedArrayCtr(this.dtype));
    }
    /**
     * Currently only supports a single integer as the size, TODO: support start, stop, step.
     */
    static arange(size, dtype = "<i4") {
        const constr = getTypedArrayCtr(dtype);
        const data = rangeTypedArray([size], constr);
        return new NestedArray(data, [size], dtype);
    }
}
/**
 * Creates a TypedArray with values 0 through N where N is the product of the shape.
 */
function rangeTypedArray(shape, tContructor) {
    const size = shape.reduce((x, y) => x * y, 1);
    const data = new tContructor(size);
    data.set([...Array(size).keys()]); // Sets range 0,1,2,3,4,5
    return data;
}
/**
 * Creates multi-dimensional (rank > 1) array given input data and shape recursively.
 * What it does is create a Array<Array<...<Array<Uint8Array>>> or some other typed array.
 * This is for internal use, there should be no need to call this from user code.
 * @param data a buffer containing the data for this array.
 * @param t constructor for the datatype of choice
 * @param shape list of numbers describing the size in each dimension
 * @param offset in bytes for this dimension
 */
function createNestedArray(data, t, shape, offset = 0) {
    if (shape.length === 1) {
        // This is only ever reached if called with rank 1 shape, never reached through recursion.
        // We just slice set the array directly from one level above to save some function calls.
        return new t(data.slice(offset, offset + shape[0] * t.BYTES_PER_ELEMENT));
    }
    const arr = new Array(shape[0]);
    if (shape.length === 2) {
        for (let i = 0; i < shape[0]; i++) {
            arr[i] = new t(data.slice(offset + shape[1] * i * t.BYTES_PER_ELEMENT, offset + shape[1] * (i + 1) * t.BYTES_PER_ELEMENT));
        }
        return arr;
    }
    const nextShape = shape.slice(1);
    // Small optimization possible here: this can be precomputed for different levels of depth and passed on.
    const mult = nextShape.reduce((x, y) => x * y, 1);
    for (let i = 0; i < shape[0]; i++) {
        arr[i] = createNestedArray(data, t, nextShape, offset + mult * i * t.BYTES_PER_ELEMENT);
    }
    return arr;
}

function setRawArrayToScalar(dstArr, dstStrides, dstShape, dstSelection, value) {
    // This translates "...", ":", null, etc into a list of slices.
    const normalizedSelection = normalizeArraySelection(dstSelection, dstShape, true);
    const [sliceIndices] = selectionToSliceIndices(normalizedSelection, dstShape);
    // Above we force the results to be SliceIndicesIndices only, without integer selections making this cast is safe.
    _setRawArrayToScalar(value, dstArr, dstStrides, sliceIndices);
}
function setRawArray(dstArr, dstStrides, dstShape, dstSelection, sourceArr, sourceStrides, sourceShape) {
    // This translates "...", ":", null, etc into a list of slices.
    const normalizedDstSelection = normalizeArraySelection(dstSelection, dstShape, false);
    const [dstSliceIndices, outShape] = selectionToSliceIndices(normalizedDstSelection, dstShape);
    // TODO: replace with non stringify equality check
    if (JSON.stringify(outShape) !== JSON.stringify(sourceShape)) {
        throw new ValueError(`Shape mismatch in target and source RawArray: ${outShape} and ${sourceShape}`);
    }
    _setRawArray(dstArr, dstStrides, dstSliceIndices, sourceArr, sourceStrides);
}
function setRawArrayFromChunkItem(dstArr, dstStrides, dstShape, dstSelection, sourceArr, sourceStrides, sourceShape, sourceSelection) {
    // This translates "...", ":", null, etc into a list of slices.
    const normalizedDstSelection = normalizeArraySelection(dstSelection, dstShape, true);
    // Above we force the results to be dstSliceIndices only, without integer selections making this cast is safe.
    const [dstSliceIndices] = selectionToSliceIndices(normalizedDstSelection, dstShape);
    const normalizedSourceSelection = normalizeArraySelection(sourceSelection, sourceShape, false);
    const [sourceSliceIndicies] = selectionToSliceIndices(normalizedSourceSelection, sourceShape);
    // TODO check to ensure chunk and dest selection are same shape?
    // As is, this only gets called in ZarrArray.getRaw where this condition should be ensured, and check might hinder performance.
    _setRawArrayFromChunkItem(dstArr, dstStrides, dstSliceIndices, sourceArr, sourceStrides, sourceSliceIndicies);
}
function _setRawArrayToScalar(value, dstArr, dstStrides, dstSliceIndices) {
    const [currentDstSlice, ...nextDstSliceIndices] = dstSliceIndices;
    const [currentDstStride, ...nextDstStrides] = dstStrides;
    const [from, _to, step, outputSize] = currentDstSlice;
    if (dstStrides.length === 1) {
        if (step === 1 && currentDstStride === 1) {
            dstArr.fill(value, from, from + outputSize);
        }
        else {
            for (let i = 0; i < outputSize; i++) {
                dstArr[currentDstStride * (from + (step * i))] = value;
            }
        }
        return;
    }
    for (let i = 0; i < outputSize; i++) {
        _setRawArrayToScalar(value, dstArr.subarray(currentDstStride * (from + (step * i))), nextDstStrides, nextDstSliceIndices);
    }
}
function _setRawArray(dstArr, dstStrides, dstSliceIndices, sourceArr, sourceStrides) {
    if (dstSliceIndices.length === 0) {
        dstArr.set(sourceArr);
        return;
    }
    const [currentDstSlice, ...nextDstSliceIndices] = dstSliceIndices;
    const [currentDstStride, ...nextDstStrides] = dstStrides;
    // This dimension is squeezed.
    if (typeof currentDstSlice === "number") {
        _setRawArray(dstArr.subarray(currentDstSlice * currentDstStride), nextDstStrides, nextDstSliceIndices, sourceArr, sourceStrides);
        return;
    }
    const [currentSourceStride, ...nextSourceStrides] = sourceStrides;
    const [from, _to, step, outputSize] = currentDstSlice;
    if (dstStrides.length === 1) {
        if (step === 1 && currentDstStride === 1 && currentSourceStride === 1) {
            dstArr.set(sourceArr.subarray(0, outputSize), from);
        }
        else {
            for (let i = 0; i < outputSize; i++) {
                dstArr[currentDstStride * (from + (step * i))] = sourceArr[currentSourceStride * i];
            }
        }
        return;
    }
    for (let i = 0; i < outputSize; i++) {
        // Apply strides as above, using both destination and source-specific strides.
        _setRawArray(dstArr.subarray(currentDstStride * (from + (i * step))), nextDstStrides, nextDstSliceIndices, sourceArr.subarray(currentSourceStride * i), nextSourceStrides);
    }
}
function _setRawArrayFromChunkItem(dstArr, dstStrides, dstSliceIndices, sourceArr, sourceStrides, sourceSliceIndices) {
    if (sourceSliceIndices.length === 0) {
        // Case when last source dimension is squeezed
        dstArr.set(sourceArr.subarray(0, dstArr.length));
        return;
    }
    // Get current indicies and strides for both destination and source arrays
    const [currentDstSlice, ...nextDstSliceIndices] = dstSliceIndices;
    const [currentSourceSlice, ...nextSourceSliceIndices] = sourceSliceIndices;
    const [currentDstStride, ...nextDstStrides] = dstStrides;
    const [currentSourceStride, ...nextSourceStrides] = sourceStrides;
    // This source dimension is squeezed
    if (typeof currentSourceSlice === "number") {
        /*
        Sets dimension offset for squeezed dimension.

        Ex. if 0th dimension is squeezed to 2nd index (numpy : arr[2,i])

            sourceArr[stride[0]* 2 + i] --> sourceArr.subarray(stride[0] * 2)[i] (sourceArr[i] in next call)

        Thus, subsequent squeezed dims are appended to the source offset.
        */
        _setRawArrayFromChunkItem(
        // Don't update destination offset/slices, just source
        dstArr, dstStrides, dstSliceIndices, sourceArr.subarray(currentSourceStride * currentSourceSlice), nextSourceStrides, nextSourceSliceIndices);
        return;
    }
    const [from, _to, step, outputSize] = currentDstSlice; // just need start and size
    const [sfrom, _sto, sstep, _soutputSize] = currentSourceSlice; // Will always be subset of dst, so don't need output size just start
    if (dstStrides.length === 1 && sourceStrides.length === 1) {
        if (step === 1 && currentDstStride === 1 && sstep === 1 && currentSourceStride === 1) {
            dstArr.set(sourceArr.subarray(sfrom, sfrom + outputSize), from);
        }
        else {
            for (let i = 0; i < outputSize; i++) {
                dstArr[currentDstStride * (from + (step * i))] = sourceArr[currentSourceStride * (sfrom + (sstep * i))];
            }
        }
        return;
    }
    for (let i = 0; i < outputSize; i++) {
        // Apply strides as above, using both destination and source-specific strides.
        _setRawArrayFromChunkItem(dstArr.subarray(currentDstStride * (from + (i * step))), nextDstStrides, nextDstSliceIndices, sourceArr.subarray(currentSourceStride * (sfrom + (i * sstep))), nextSourceStrides, nextSourceSliceIndices);
    }
}

class RawArray {
    constructor(data, shape, dtype, strides) {
        const dataIsTypedArray = data !== null && !!data.BYTES_PER_ELEMENT;
        if (shape === undefined) {
            if (!dataIsTypedArray) {
                throw new ValueError("Shape argument is required unless you pass in a TypedArray");
            }
            shape = [data.length];
        }
        shape = normalizeShape(shape);
        if (dtype === undefined) {
            if (!dataIsTypedArray) {
                throw new ValueError("Dtype argument is required unless you pass in a TypedArray");
            }
            dtype = getTypedArrayDtypeString(data);
        }
        if (strides === undefined) {
            strides = getStrides(shape);
        }
        this.shape = shape;
        this.dtype = dtype;
        this.strides = strides;
        if (dataIsTypedArray && shape.length !== 1) {
            data = data.buffer;
        }
        // Zero dimension array.. they are a bit weirdly represented now, they will only ever occur internally
        if (this.shape.length === 0) {
            this.data = new (getTypedArrayCtr(dtype))(1);
        }
        else if (
        // tslint:disable-next-line: strict-type-predicates
        (IS_NODE && Buffer.isBuffer(data))
            || isArrayBufferLike(data)
            || data === null) {
            // Create from ArrayBuffer or Buffer
            const numShapeElements = shape.reduce((x, y) => x * y, 1);
            if (data === null) {
                data = new ArrayBuffer(numShapeElements * parseInt(dtype[dtype.length - 1], 10));
            }
            const numDataElements = data.byteLength / parseInt(dtype[dtype.length - 1], 10);
            if (numShapeElements !== numDataElements) {
                throw new Error(`Buffer has ${numDataElements} of dtype ${dtype}, shape is too large or small ${shape} (flat=${numShapeElements})`);
            }
            const typeConstructor = getTypedArrayCtr(dtype);
            this.data = new typeConstructor(data);
        }
        else {
            this.data = data;
        }
    }
    set(selection = null, value, chunkSelection) {
        if (selection === null) {
            selection = [slice(null)];
        }
        if (typeof value === "number") {
            if (this.shape.length === 0) {
                // Zero dimension array..
                this.data[0] = value;
            }
            else {
                setRawArrayToScalar(this.data, this.strides, this.shape, selection, value);
            }
        }
        else if (value instanceof RawArray && chunkSelection) {
            // Copy directly from decoded chunk to destination array
            setRawArrayFromChunkItem(this.data, this.strides, this.shape, selection, value.data, value.strides, value.shape, chunkSelection);
        }
        else {
            setRawArray(this.data, this.strides, this.shape, selection, value.data, value.strides, value.shape);
        }
    }
}

var eventemitter3 = {exports: {}};

(function (module) {

var has = Object.prototype.hasOwnProperty
  , prefix = '~';

/**
 * Constructor to create a storage for our `EE` objects.
 * An `Events` instance is a plain object whose properties are event names.
 *
 * @constructor
 * @private
 */
function Events() {}

//
// We try to not inherit from `Object.prototype`. In some engines creating an
// instance in this way is faster than calling `Object.create(null)` directly.
// If `Object.create(null)` is not supported we prefix the event names with a
// character to make sure that the built-in object properties are not
// overridden or used as an attack vector.
//
if (Object.create) {
  Events.prototype = Object.create(null);

  //
  // This hack is needed because the `__proto__` property is still inherited in
  // some old browsers like Android 4, iPhone 5.1, Opera 11 and Safari 5.
  //
  if (!new Events().__proto__) prefix = false;
}

/**
 * Representation of a single event listener.
 *
 * @param {Function} fn The listener function.
 * @param {*} context The context to invoke the listener with.
 * @param {Boolean} [once=false] Specify if the listener is a one-time listener.
 * @constructor
 * @private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Add a listener for a given event.
 *
 * @param {EventEmitter} emitter Reference to the `EventEmitter` instance.
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn The listener function.
 * @param {*} context The context to invoke the listener with.
 * @param {Boolean} once Specify if the listener is a one-time listener.
 * @returns {EventEmitter}
 * @private
 */
function addListener(emitter, event, fn, context, once) {
  if (typeof fn !== 'function') {
    throw new TypeError('The listener must be a function');
  }

  var listener = new EE(fn, context || emitter, once)
    , evt = prefix ? prefix + event : event;

  if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
  else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
  else emitter._events[evt] = [emitter._events[evt], listener];

  return emitter;
}

/**
 * Clear event by name.
 *
 * @param {EventEmitter} emitter Reference to the `EventEmitter` instance.
 * @param {(String|Symbol)} evt The Event name.
 * @private
 */
function clearEvent(emitter, evt) {
  if (--emitter._eventsCount === 0) emitter._events = new Events();
  else delete emitter._events[evt];
}

/**
 * Minimal `EventEmitter` interface that is molded against the Node.js
 * `EventEmitter` interface.
 *
 * @constructor
 * @public
 */
function EventEmitter() {
  this._events = new Events();
  this._eventsCount = 0;
}

/**
 * Return an array listing the events for which the emitter has registered
 * listeners.
 *
 * @returns {Array}
 * @public
 */
EventEmitter.prototype.eventNames = function eventNames() {
  var names = []
    , events
    , name;

  if (this._eventsCount === 0) return names;

  for (name in (events = this._events)) {
    if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
  }

  if (Object.getOwnPropertySymbols) {
    return names.concat(Object.getOwnPropertySymbols(events));
  }

  return names;
};

/**
 * Return the listeners registered for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @returns {Array} The registered listeners.
 * @public
 */
EventEmitter.prototype.listeners = function listeners(event) {
  var evt = prefix ? prefix + event : event
    , handlers = this._events[evt];

  if (!handlers) return [];
  if (handlers.fn) return [handlers.fn];

  for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
    ee[i] = handlers[i].fn;
  }

  return ee;
};

/**
 * Return the number of listeners listening to a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @returns {Number} The number of listeners.
 * @public
 */
EventEmitter.prototype.listenerCount = function listenerCount(event) {
  var evt = prefix ? prefix + event : event
    , listeners = this._events[evt];

  if (!listeners) return 0;
  if (listeners.fn) return 1;
  return listeners.length;
};

/**
 * Calls each of the listeners registered for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @returns {Boolean} `true` if the event had listeners, else `false`.
 * @public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  var evt = prefix ? prefix + event : event;

  if (!this._events[evt]) return false;

  var listeners = this._events[evt]
    , len = arguments.length
    , args
    , i;

  if (listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, undefined, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, undefined, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        case 4: listeners[i].fn.call(listeners[i].context, a1, a2, a3); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Add a listener for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn The listener function.
 * @param {*} [context=this] The context to invoke the listener with.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  return addListener(this, event, fn, context, false);
};

/**
 * Add a one-time listener for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn The listener function.
 * @param {*} [context=this] The context to invoke the listener with.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  return addListener(this, event, fn, context, true);
};

/**
 * Remove the listeners of a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn Only remove the listeners that match this function.
 * @param {*} context Only remove the listeners that have this context.
 * @param {Boolean} once Only remove one-time listeners.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
  var evt = prefix ? prefix + event : event;

  if (!this._events[evt]) return this;
  if (!fn) {
    clearEvent(this, evt);
    return this;
  }

  var listeners = this._events[evt];

  if (listeners.fn) {
    if (
      listeners.fn === fn &&
      (!once || listeners.once) &&
      (!context || listeners.context === context)
    ) {
      clearEvent(this, evt);
    }
  } else {
    for (var i = 0, events = [], length = listeners.length; i < length; i++) {
      if (
        listeners[i].fn !== fn ||
        (once && !listeners[i].once) ||
        (context && listeners[i].context !== context)
      ) {
        events.push(listeners[i]);
      }
    }

    //
    // Reset the array, or remove it completely if we have no more listeners.
    //
    if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
    else clearEvent(this, evt);
  }

  return this;
};

/**
 * Remove all listeners, or those of the specified event.
 *
 * @param {(String|Symbol)} [event] The event name.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  var evt;

  if (event) {
    evt = prefix ? prefix + event : event;
    if (this._events[evt]) clearEvent(this, evt);
  } else {
    this._events = new Events();
    this._eventsCount = 0;
  }

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// Expose the prefix.
//
EventEmitter.prefixed = prefix;

//
// Allow `EventEmitter` to be imported as module namespace.
//
EventEmitter.EventEmitter = EventEmitter;

//
// Expose the module.
//
{
  module.exports = EventEmitter;
}
}(eventemitter3));

var EventEmitter = eventemitter3.exports;

class TimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TimeoutError';
	}
}

/**
An error to be thrown when the request is aborted by AbortController.
DOMException is thrown instead of this Error when DOMException is available.
*/
class AbortError$1 extends Error {
	constructor(message) {
		super();
		this.name = 'AbortError';
		this.message = message;
	}
}

/**
TODO: Remove AbortError and just throw DOMException when targeting Node 18.
*/
const getDOMException = errorMessage => globalThis.DOMException === undefined ?
	new AbortError$1(errorMessage) :
	new DOMException(errorMessage);

/**
TODO: Remove below function and just 'reject(signal.reason)' when targeting Node 18.
*/
const getAbortedReason = signal => {
	const reason = signal.reason === undefined ?
		getDOMException('This operation was aborted.') :
		signal.reason;

	return reason instanceof Error ? reason : getDOMException(reason);
};

function pTimeout(promise, milliseconds, fallback, options) {
	let timer;

	const cancelablePromise = new Promise((resolve, reject) => {
		if (typeof milliseconds !== 'number' || Math.sign(milliseconds) !== 1) {
			throw new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
		}

		if (milliseconds === Number.POSITIVE_INFINITY) {
			resolve(promise);
			return;
		}

		options = {
			customTimers: {setTimeout, clearTimeout},
			...options
		};

		if (options.signal) {
			const {signal} = options;
			if (signal.aborted) {
				reject(getAbortedReason(signal));
			}

			signal.addEventListener('abort', () => {
				reject(getAbortedReason(signal));
			});
		}

		timer = options.customTimers.setTimeout.call(undefined, () => {
			if (typeof fallback === 'function') {
				try {
					resolve(fallback());
				} catch (error) {
					reject(error);
				}

				return;
			}

			const message = typeof fallback === 'string' ? fallback : `Promise timed out after ${milliseconds} milliseconds`;
			const timeoutError = fallback instanceof Error ? fallback : new TimeoutError(message);

			if (typeof promise.cancel === 'function') {
				promise.cancel();
			}

			reject(timeoutError);
		}, milliseconds);

		(async () => {
			try {
				resolve(await promise);
			} catch (error) {
				reject(error);
			} finally {
				options.customTimers.clearTimeout.call(undefined, timer);
			}
		})();
	});

	cancelablePromise.clear = () => {
		clearTimeout(timer);
		timer = undefined;
	};

	return cancelablePromise;
}

// Port of lower_bound from https://en.cppreference.com/w/cpp/algorithm/lower_bound
// Used to compute insertion index to keep queue sorted after insertion
function lowerBound(array, value, comparator) {
    let first = 0;
    let count = array.length;
    while (count > 0) {
        const step = Math.trunc(count / 2);
        let it = first + step;
        if (comparator(array[it], value) <= 0) {
            first = ++it;
            count -= step + 1;
        }
        else {
            count = step;
        }
    }
    return first;
}

var __classPrivateFieldGet$1 = (undefined && undefined.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _PriorityQueue_queue;
class PriorityQueue {
    constructor() {
        _PriorityQueue_queue.set(this, []);
    }
    enqueue(run, options) {
        options = {
            priority: 0,
            ...options,
        };
        const element = {
            priority: options.priority,
            run,
        };
        if (this.size && __classPrivateFieldGet$1(this, _PriorityQueue_queue, "f")[this.size - 1].priority >= options.priority) {
            __classPrivateFieldGet$1(this, _PriorityQueue_queue, "f").push(element);
            return;
        }
        const index = lowerBound(__classPrivateFieldGet$1(this, _PriorityQueue_queue, "f"), element, (a, b) => b.priority - a.priority);
        __classPrivateFieldGet$1(this, _PriorityQueue_queue, "f").splice(index, 0, element);
    }
    dequeue() {
        const item = __classPrivateFieldGet$1(this, _PriorityQueue_queue, "f").shift();
        return item === null || item === void 0 ? void 0 : item.run;
    }
    filter(options) {
        return __classPrivateFieldGet$1(this, _PriorityQueue_queue, "f").filter((element) => element.priority === options.priority).map((element) => element.run);
    }
    get size() {
        return __classPrivateFieldGet$1(this, _PriorityQueue_queue, "f").length;
    }
}
_PriorityQueue_queue = new WeakMap();

var __classPrivateFieldSet = (undefined && undefined.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (undefined && undefined.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _PQueue_instances, _PQueue_carryoverConcurrencyCount, _PQueue_isIntervalIgnored, _PQueue_intervalCount, _PQueue_intervalCap, _PQueue_interval, _PQueue_intervalEnd, _PQueue_intervalId, _PQueue_timeoutId, _PQueue_queue, _PQueue_queueClass, _PQueue_pending, _PQueue_concurrency, _PQueue_isPaused, _PQueue_throwOnTimeout, _PQueue_doesIntervalAllowAnother_get, _PQueue_doesConcurrentAllowAnother_get, _PQueue_next, _PQueue_onResumeInterval, _PQueue_isIntervalPaused_get, _PQueue_tryToStartAnother, _PQueue_initializeIntervalIfNeeded, _PQueue_onInterval, _PQueue_processQueue, _PQueue_throwOnAbort, _PQueue_onEvent;
/**
The error thrown by `queue.add()` when a job is aborted before it is run. See `signal`.
*/
class AbortError extends Error {
}
/**
Promise queue with concurrency control.
*/
class PQueue extends EventEmitter {
    // TODO: The `throwOnTimeout` option should affect the return types of `add()` and `addAll()`
    constructor(options) {
        var _a, _b, _c, _d;
        super();
        _PQueue_instances.add(this);
        _PQueue_carryoverConcurrencyCount.set(this, void 0);
        _PQueue_isIntervalIgnored.set(this, void 0);
        _PQueue_intervalCount.set(this, 0);
        _PQueue_intervalCap.set(this, void 0);
        _PQueue_interval.set(this, void 0);
        _PQueue_intervalEnd.set(this, 0);
        _PQueue_intervalId.set(this, void 0);
        _PQueue_timeoutId.set(this, void 0);
        _PQueue_queue.set(this, void 0);
        _PQueue_queueClass.set(this, void 0);
        _PQueue_pending.set(this, 0);
        // The `!` is needed because of https://github.com/microsoft/TypeScript/issues/32194
        _PQueue_concurrency.set(this, void 0);
        _PQueue_isPaused.set(this, void 0);
        _PQueue_throwOnTimeout.set(this, void 0);
        /**
        Per-operation timeout in milliseconds. Operations fulfill once `timeout` elapses if they haven't already.
    
        Applies to each future operation.
        */
        Object.defineProperty(this, "timeout", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        options = {
            carryoverConcurrencyCount: false,
            intervalCap: Number.POSITIVE_INFINITY,
            interval: 0,
            concurrency: Number.POSITIVE_INFINITY,
            autoStart: true,
            queueClass: PriorityQueue,
            ...options,
        };
        if (!(typeof options.intervalCap === 'number' && options.intervalCap >= 1)) {
            throw new TypeError(`Expected \`intervalCap\` to be a number from 1 and up, got \`${(_b = (_a = options.intervalCap) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : ''}\` (${typeof options.intervalCap})`);
        }
        if (options.interval === undefined || !(Number.isFinite(options.interval) && options.interval >= 0)) {
            throw new TypeError(`Expected \`interval\` to be a finite number >= 0, got \`${(_d = (_c = options.interval) === null || _c === void 0 ? void 0 : _c.toString()) !== null && _d !== void 0 ? _d : ''}\` (${typeof options.interval})`);
        }
        __classPrivateFieldSet(this, _PQueue_carryoverConcurrencyCount, options.carryoverConcurrencyCount, "f");
        __classPrivateFieldSet(this, _PQueue_isIntervalIgnored, options.intervalCap === Number.POSITIVE_INFINITY || options.interval === 0, "f");
        __classPrivateFieldSet(this, _PQueue_intervalCap, options.intervalCap, "f");
        __classPrivateFieldSet(this, _PQueue_interval, options.interval, "f");
        __classPrivateFieldSet(this, _PQueue_queue, new options.queueClass(), "f");
        __classPrivateFieldSet(this, _PQueue_queueClass, options.queueClass, "f");
        this.concurrency = options.concurrency;
        this.timeout = options.timeout;
        __classPrivateFieldSet(this, _PQueue_throwOnTimeout, options.throwOnTimeout === true, "f");
        __classPrivateFieldSet(this, _PQueue_isPaused, options.autoStart === false, "f");
    }
    get concurrency() {
        return __classPrivateFieldGet(this, _PQueue_concurrency, "f");
    }
    set concurrency(newConcurrency) {
        if (!(typeof newConcurrency === 'number' && newConcurrency >= 1)) {
            throw new TypeError(`Expected \`concurrency\` to be a number from 1 and up, got \`${newConcurrency}\` (${typeof newConcurrency})`);
        }
        __classPrivateFieldSet(this, _PQueue_concurrency, newConcurrency, "f");
        __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_processQueue).call(this);
    }
    async add(function_, options = {}) {
        options = {
            timeout: this.timeout,
            throwOnTimeout: __classPrivateFieldGet(this, _PQueue_throwOnTimeout, "f"),
            ...options,
        };
        return new Promise((resolve, reject) => {
            __classPrivateFieldGet(this, _PQueue_queue, "f").enqueue(async () => {
                var _a;
                var _b, _c;
                __classPrivateFieldSet(this, _PQueue_pending, (_b = __classPrivateFieldGet(this, _PQueue_pending, "f"), _b++, _b), "f");
                __classPrivateFieldSet(this, _PQueue_intervalCount, (_c = __classPrivateFieldGet(this, _PQueue_intervalCount, "f"), _c++, _c), "f");
                try {
                    // TODO: Use options.signal?.throwIfAborted() when targeting Node.js 18
                    if ((_a = options.signal) === null || _a === void 0 ? void 0 : _a.aborted) {
                        // TODO: Use ABORT_ERR code when targeting Node.js 16 (https://nodejs.org/docs/latest-v16.x/api/errors.html#abort_err)
                        throw new AbortError('The task was aborted.');
                    }
                    let operation = function_({ signal: options.signal });
                    if (options.timeout) {
                        operation = pTimeout(Promise.resolve(operation), options.timeout);
                    }
                    if (options.signal) {
                        operation = Promise.race([operation, __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_throwOnAbort).call(this, options.signal)]);
                    }
                    const result = await operation;
                    resolve(result);
                    this.emit('completed', result);
                }
                catch (error) {
                    if (error instanceof TimeoutError && !options.throwOnTimeout) {
                        resolve();
                        return;
                    }
                    reject(error);
                    this.emit('error', error);
                }
                finally {
                    __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_next).call(this);
                }
            }, options);
            this.emit('add');
            __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_tryToStartAnother).call(this);
        });
    }
    async addAll(functions, options) {
        return Promise.all(functions.map(async (function_) => this.add(function_, options)));
    }
    /**
    Start (or resume) executing enqueued tasks within concurrency limit. No need to call this if queue is not paused (via `options.autoStart = false` or by `.pause()` method.)
    */
    start() {
        if (!__classPrivateFieldGet(this, _PQueue_isPaused, "f")) {
            return this;
        }
        __classPrivateFieldSet(this, _PQueue_isPaused, false, "f");
        __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_processQueue).call(this);
        return this;
    }
    /**
    Put queue execution on hold.
    */
    pause() {
        __classPrivateFieldSet(this, _PQueue_isPaused, true, "f");
    }
    /**
    Clear the queue.
    */
    clear() {
        __classPrivateFieldSet(this, _PQueue_queue, new (__classPrivateFieldGet(this, _PQueue_queueClass, "f"))(), "f");
    }
    /**
    Can be called multiple times. Useful if you for example add additional items at a later time.

    @returns A promise that settles when the queue becomes empty.
    */
    async onEmpty() {
        // Instantly resolve if the queue is empty
        if (__classPrivateFieldGet(this, _PQueue_queue, "f").size === 0) {
            return;
        }
        await __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_onEvent).call(this, 'empty');
    }
    /**
    @returns A promise that settles when the queue size is less than the given limit: `queue.size < limit`.

    If you want to avoid having the queue grow beyond a certain size you can `await queue.onSizeLessThan()` before adding a new item.

    Note that this only limits the number of items waiting to start. There could still be up to `concurrency` jobs already running that this call does not include in its calculation.
    */
    async onSizeLessThan(limit) {
        // Instantly resolve if the queue is empty.
        if (__classPrivateFieldGet(this, _PQueue_queue, "f").size < limit) {
            return;
        }
        await __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_onEvent).call(this, 'next', () => __classPrivateFieldGet(this, _PQueue_queue, "f").size < limit);
    }
    /**
    The difference with `.onEmpty` is that `.onIdle` guarantees that all work from the queue has finished. `.onEmpty` merely signals that the queue is empty, but it could mean that some promises haven't completed yet.

    @returns A promise that settles when the queue becomes empty, and all promises have completed; `queue.size === 0 && queue.pending === 0`.
    */
    async onIdle() {
        // Instantly resolve if none pending and if nothing else is queued
        if (__classPrivateFieldGet(this, _PQueue_pending, "f") === 0 && __classPrivateFieldGet(this, _PQueue_queue, "f").size === 0) {
            return;
        }
        await __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_onEvent).call(this, 'idle');
    }
    /**
    Size of the queue, the number of queued items waiting to run.
    */
    get size() {
        return __classPrivateFieldGet(this, _PQueue_queue, "f").size;
    }
    /**
    Size of the queue, filtered by the given options.

    For example, this can be used to find the number of items remaining in the queue with a specific priority level.
    */
    sizeBy(options) {
        // eslint-disable-next-line unicorn/no-array-callback-reference
        return __classPrivateFieldGet(this, _PQueue_queue, "f").filter(options).length;
    }
    /**
    Number of running items (no longer in the queue).
    */
    get pending() {
        return __classPrivateFieldGet(this, _PQueue_pending, "f");
    }
    /**
    Whether the queue is currently paused.
    */
    get isPaused() {
        return __classPrivateFieldGet(this, _PQueue_isPaused, "f");
    }
}
_PQueue_carryoverConcurrencyCount = new WeakMap(), _PQueue_isIntervalIgnored = new WeakMap(), _PQueue_intervalCount = new WeakMap(), _PQueue_intervalCap = new WeakMap(), _PQueue_interval = new WeakMap(), _PQueue_intervalEnd = new WeakMap(), _PQueue_intervalId = new WeakMap(), _PQueue_timeoutId = new WeakMap(), _PQueue_queue = new WeakMap(), _PQueue_queueClass = new WeakMap(), _PQueue_pending = new WeakMap(), _PQueue_concurrency = new WeakMap(), _PQueue_isPaused = new WeakMap(), _PQueue_throwOnTimeout = new WeakMap(), _PQueue_instances = new WeakSet(), _PQueue_doesIntervalAllowAnother_get = function _PQueue_doesIntervalAllowAnother_get() {
    return __classPrivateFieldGet(this, _PQueue_isIntervalIgnored, "f") || __classPrivateFieldGet(this, _PQueue_intervalCount, "f") < __classPrivateFieldGet(this, _PQueue_intervalCap, "f");
}, _PQueue_doesConcurrentAllowAnother_get = function _PQueue_doesConcurrentAllowAnother_get() {
    return __classPrivateFieldGet(this, _PQueue_pending, "f") < __classPrivateFieldGet(this, _PQueue_concurrency, "f");
}, _PQueue_next = function _PQueue_next() {
    var _a;
    __classPrivateFieldSet(this, _PQueue_pending, (_a = __classPrivateFieldGet(this, _PQueue_pending, "f"), _a--, _a), "f");
    __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_tryToStartAnother).call(this);
    this.emit('next');
}, _PQueue_onResumeInterval = function _PQueue_onResumeInterval() {
    __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_onInterval).call(this);
    __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_initializeIntervalIfNeeded).call(this);
    __classPrivateFieldSet(this, _PQueue_timeoutId, undefined, "f");
}, _PQueue_isIntervalPaused_get = function _PQueue_isIntervalPaused_get() {
    const now = Date.now();
    if (__classPrivateFieldGet(this, _PQueue_intervalId, "f") === undefined) {
        const delay = __classPrivateFieldGet(this, _PQueue_intervalEnd, "f") - now;
        if (delay < 0) {
            // Act as the interval was done
            // We don't need to resume it here because it will be resumed on line 160
            __classPrivateFieldSet(this, _PQueue_intervalCount, (__classPrivateFieldGet(this, _PQueue_carryoverConcurrencyCount, "f")) ? __classPrivateFieldGet(this, _PQueue_pending, "f") : 0, "f");
        }
        else {
            // Act as the interval is pending
            if (__classPrivateFieldGet(this, _PQueue_timeoutId, "f") === undefined) {
                __classPrivateFieldSet(this, _PQueue_timeoutId, setTimeout(() => {
                    __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_onResumeInterval).call(this);
                }, delay), "f");
            }
            return true;
        }
    }
    return false;
}, _PQueue_tryToStartAnother = function _PQueue_tryToStartAnother() {
    if (__classPrivateFieldGet(this, _PQueue_queue, "f").size === 0) {
        // We can clear the interval ("pause")
        // Because we can redo it later ("resume")
        if (__classPrivateFieldGet(this, _PQueue_intervalId, "f")) {
            clearInterval(__classPrivateFieldGet(this, _PQueue_intervalId, "f"));
        }
        __classPrivateFieldSet(this, _PQueue_intervalId, undefined, "f");
        this.emit('empty');
        if (__classPrivateFieldGet(this, _PQueue_pending, "f") === 0) {
            this.emit('idle');
        }
        return false;
    }
    if (!__classPrivateFieldGet(this, _PQueue_isPaused, "f")) {
        const canInitializeInterval = !__classPrivateFieldGet(this, _PQueue_instances, "a", _PQueue_isIntervalPaused_get);
        if (__classPrivateFieldGet(this, _PQueue_instances, "a", _PQueue_doesIntervalAllowAnother_get) && __classPrivateFieldGet(this, _PQueue_instances, "a", _PQueue_doesConcurrentAllowAnother_get)) {
            const job = __classPrivateFieldGet(this, _PQueue_queue, "f").dequeue();
            if (!job) {
                return false;
            }
            this.emit('active');
            job();
            if (canInitializeInterval) {
                __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_initializeIntervalIfNeeded).call(this);
            }
            return true;
        }
    }
    return false;
}, _PQueue_initializeIntervalIfNeeded = function _PQueue_initializeIntervalIfNeeded() {
    if (__classPrivateFieldGet(this, _PQueue_isIntervalIgnored, "f") || __classPrivateFieldGet(this, _PQueue_intervalId, "f") !== undefined) {
        return;
    }
    __classPrivateFieldSet(this, _PQueue_intervalId, setInterval(() => {
        __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_onInterval).call(this);
    }, __classPrivateFieldGet(this, _PQueue_interval, "f")), "f");
    __classPrivateFieldSet(this, _PQueue_intervalEnd, Date.now() + __classPrivateFieldGet(this, _PQueue_interval, "f"), "f");
}, _PQueue_onInterval = function _PQueue_onInterval() {
    if (__classPrivateFieldGet(this, _PQueue_intervalCount, "f") === 0 && __classPrivateFieldGet(this, _PQueue_pending, "f") === 0 && __classPrivateFieldGet(this, _PQueue_intervalId, "f")) {
        clearInterval(__classPrivateFieldGet(this, _PQueue_intervalId, "f"));
        __classPrivateFieldSet(this, _PQueue_intervalId, undefined, "f");
    }
    __classPrivateFieldSet(this, _PQueue_intervalCount, __classPrivateFieldGet(this, _PQueue_carryoverConcurrencyCount, "f") ? __classPrivateFieldGet(this, _PQueue_pending, "f") : 0, "f");
    __classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_processQueue).call(this);
}, _PQueue_processQueue = function _PQueue_processQueue() {
    // eslint-disable-next-line no-empty
    while (__classPrivateFieldGet(this, _PQueue_instances, "m", _PQueue_tryToStartAnother).call(this)) { }
}, _PQueue_throwOnAbort = async function _PQueue_throwOnAbort(signal) {
    return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
            // TODO: Reject with signal.throwIfAborted() when targeting Node.js 18
            // TODO: Use ABORT_ERR code when targeting Node.js 16 (https://nodejs.org/docs/latest-v16.x/api/errors.html#abort_err)
            reject(new AbortError('The task was aborted.'));
        }, { once: true });
    });
}, _PQueue_onEvent = async function _PQueue_onEvent(event, filter) {
    return new Promise(resolve => {
        const listener = () => {
            if (filter && !filter()) {
                return;
            }
            this.off(event, listener);
            resolve();
        };
        this.on(event, listener);
    });
};

class ZarrArray {
    /**
     * Instantiate an array from an initialized store.
     * @param store Array store, already initialized.
     * @param path Storage path.
     * @param metadata The initial value for the metadata
     * @param readOnly True if array should be protected against modification.
     * @param chunkStore Separate storage for chunks. If not provided, `store` will be used for storage of both chunks and metadata.
     * @param cacheMetadata If true (default), array configuration metadata will be cached for the lifetime of the object.
     * If false, array metadata will be reloaded prior to all data access and modification operations (may incur overhead depending on storage and data access pattern).
     * @param cacheAttrs If true (default), user attributes will be cached for attribute read operations.
     * If false, user attributes are reloaded from the store prior to all attribute read operations.
     */
    constructor(store, path = null, metadata, readOnly = false, chunkStore = null, cacheMetadata = true, cacheAttrs = true) {
        // N.B., expect at this point store is fully initialized with all
        // configuration metadata fully specified and normalized
        this.store = store;
        this._chunkStore = chunkStore;
        this.path = normalizeStoragePath(path);
        this.keyPrefix = pathToPrefix(this.path);
        this.readOnly = readOnly;
        this.cacheMetadata = cacheMetadata;
        this.cacheAttrs = cacheAttrs;
        this.meta = metadata;
        if (this.meta.compressor !== null) {
            this.compressor = getCodec(this.meta.compressor);
        }
        else {
            this.compressor = null;
        }
        const attrKey = this.keyPrefix + ATTRS_META_KEY;
        this.attrs = new Attributes(this.store, attrKey, this.readOnly, cacheAttrs);
    }
    /**
     * A `Store` providing the underlying storage for array chunks.
     */
    get chunkStore() {
        if (this._chunkStore) {
            return this._chunkStore;
        }
        return this.store;
    }
    /**
     * Array name following h5py convention.
     */
    get name() {
        if (this.path.length > 0) {
            if (this.path[0] !== "/") {
                return "/" + this.path;
            }
            return this.path;
        }
        return null;
    }
    /**
     * Final component of name.
     */
    get basename() {
        const name = this.name;
        if (name === null) {
            return null;
        }
        const parts = name.split("/");
        return parts[parts.length - 1];
    }
    /**
     * "A list of integers describing the length of each dimension of the array.
     */
    get shape() {
        // this.refreshMetadata();
        return this.meta.shape;
    }
    /**
     * A list of integers describing the length of each dimension of a chunk of the array.
     */
    get chunks() {
        return this.meta.chunks;
    }
    /**
     * Integer describing how many element a chunk contains
     */
    get chunkSize() {
        return this.chunks.reduce((x, y) => x * y, 1);
    }
    /**
     *  The NumPy data type.
     */
    get dtype() {
        return this.meta.dtype;
    }
    /**
     *  A value used for uninitialized portions of the array.
     */
    get fillValue() {
        const fillTypeValue = this.meta.fill_value;
        // TODO extract into function
        if (fillTypeValue === "NaN") {
            return NaN;
        }
        else if (fillTypeValue === "Infinity") {
            return Infinity;
        }
        else if (fillTypeValue === "-Infinity") {
            return -Infinity;
        }
        return this.meta.fill_value;
    }
    /**
     *  Number of dimensions.
     */
    get nDims() {
        return this.meta.shape.length;
    }
    /**
     *  The total number of elements in the array.
     */
    get size() {
        // this.refreshMetadata()
        return this.meta.shape.reduce((x, y) => x * y, 1);
    }
    get length() {
        return this.shape[0];
    }
    get _chunkDataShape() {
        if (this.shape.length === 0) {
            return [1];
        }
        else {
            const s = [];
            for (let i = 0; i < this.shape.length; i++) {
                s[i] = Math.ceil(this.shape[i] / this.chunks[i]);
            }
            return s;
        }
    }
    /**
     * A tuple of integers describing the number of chunks along each
     * dimension of the array.
     */
    get chunkDataShape() {
        // this.refreshMetadata();
        return this._chunkDataShape;
    }
    /**
     * Total number of chunks.
     */
    get numChunks() {
        // this.refreshMetadata();
        return this.chunkDataShape.reduce((x, y) => x * y, 1);
    }
    /**
     * Instantiate an array from an initialized store.
     * @param store Array store, already initialized.
     * @param path Storage path.
     * @param readOnly True if array should be protected against modification.
     * @param chunkStore Separate storage for chunks. If not provided, `store` will be used for storage of both chunks and metadata.
     * @param cacheMetadata If true (default), array configuration metadata will be cached for the lifetime of the object.
     * If false, array metadata will be reloaded prior to all data access and modification operations (may incur overhead depending on storage and data access pattern).
     * @param cacheAttrs If true (default), user attributes will be cached for attribute read operations.
     * If false, user attributes are reloaded from the store prior to all attribute read operations.
     */
    static async create(store, path = null, readOnly = false, chunkStore = null, cacheMetadata = true, cacheAttrs = true) {
        const metadata = await this.loadMetadataForConstructor(store, path);
        return new ZarrArray(store, path, metadata, readOnly, chunkStore, cacheMetadata, cacheAttrs);
    }
    static async loadMetadataForConstructor(store, path) {
        try {
            path = normalizeStoragePath(path);
            const keyPrefix = pathToPrefix(path);
            const metaStoreValue = await store.getItem(keyPrefix + ARRAY_META_KEY);
            return parseMetadata(metaStoreValue);
        }
        catch (error) {
            if (await containsGroup(store, path)) {
                throw new ContainsGroupError(path !== null && path !== void 0 ? path : '');
            }
            throw new Error("Failed to load metadata for ZarrArray:" + error.toString());
        }
    }
    /**
     * (Re)load metadata from store
     */
    async reloadMetadata() {
        const metaKey = this.keyPrefix + ARRAY_META_KEY;
        const metaStoreValue = this.store.getItem(metaKey);
        this.meta = parseMetadata(await metaStoreValue);
        return this.meta;
    }
    async refreshMetadata() {
        if (!this.cacheMetadata) {
            await this.reloadMetadata();
        }
    }
    get(selection = null, opts = {}) {
        return this.getBasicSelection(selection, false, opts);
    }
    getRaw(selection = null, opts = {}) {
        return this.getBasicSelection(selection, true, opts);
    }
    async getBasicSelection(selection, asRaw = false, { concurrencyLimit = 10, progressCallback, storeOptions } = {}) {
        // Refresh metadata
        if (!this.cacheMetadata) {
            await this.reloadMetadata();
        }
        // Check fields (TODO?)
        if (this.shape.length === 0) {
            throw new Error("Shape [] indexing is not supported yet");
        }
        else {
            return this.getBasicSelectionND(selection, asRaw, concurrencyLimit, progressCallback, storeOptions);
        }
    }
    getBasicSelectionND(selection, asRaw, concurrencyLimit, progressCallback, storeOptions) {
        const indexer = new BasicIndexer(selection, this);
        return this.getSelection(indexer, asRaw, concurrencyLimit, progressCallback, storeOptions);
    }
    async getSelection(indexer, asRaw, concurrencyLimit, progressCallback, storeOptions) {
        // We iterate over all chunks which overlap the selection and thus contain data
        // that needs to be extracted. Each chunk is processed in turn, extracting the
        // necessary data and storing into the correct location in the output array.
        // N.B., it is an important optimisation that we only visit chunks which overlap
        // the selection. This minimises the number of iterations in the main for loop.
        // check fields are sensible (TODO?)
        const outDtype = this.dtype;
        const outShape = indexer.shape;
        const outSize = indexer.shape.reduce((x, y) => x * y, 1);
        if (asRaw && (outSize === this.chunkSize)) {
            // Optimization: if output strided array _is_ chunk exactly,
            // decode directly as new TypedArray and return
            const itr = indexer.iter();
            const proj = itr.next(); // ensure there is only one projection
            if (proj.done === false && itr.next().done === true) {
                const chunkProjection = proj.value;
                const out = await this.decodeDirectToRawArray(chunkProjection, outShape, outSize);
                return out;
            }
        }
        const out = asRaw
            ? new RawArray(null, outShape, outDtype)
            : new NestedArray(null, outShape, outDtype);
        if (outSize === 0) {
            return out;
        }
        // create promise queue with concurrency control
        const queue = new PQueue({ concurrency: concurrencyLimit });
        const allTasks = [];
        if (progressCallback) {
            let progress = 0;
            let queueSize = 0;
            for (const _ of indexer.iter())
                queueSize += 1;
            progressCallback({ progress: 0, queueSize: queueSize });
            for (const proj of indexer.iter()) {
                allTasks.push(queue.add(async () => {
                    await this.chunkGetItem(proj.chunkCoords, proj.chunkSelection, out, proj.outSelection, indexer.dropAxes, storeOptions);
                    progress += 1;
                    progressCallback({ progress: progress, queueSize: queueSize });
                }));
            }
        }
        else {
            for (const proj of indexer.iter()) {
                allTasks.push(queue.add(() => this.chunkGetItem(proj.chunkCoords, proj.chunkSelection, out, proj.outSelection, indexer.dropAxes, storeOptions)));
            }
        }
        // guarantees that all work on queue has finished and throws if any of the tasks errored.
        await Promise.all(allTasks);
        // Return scalar instead of zero-dimensional array.
        if (out.shape.length === 0) {
            return out.data[0];
        }
        return out;
    }
    /**
     * Obtain part or whole of a chunk.
     * @param chunkCoords Indices of the chunk.
     * @param chunkSelection Location of region within the chunk to extract.
     * @param out Array to store result in.
     * @param outSelection Location of region within output array to store results in.
     * @param dropAxes Axes to squeeze out of the chunk.
     */
    async chunkGetItem(chunkCoords, chunkSelection, out, outSelection, dropAxes, storeOptions) {
        if (chunkCoords.length !== this._chunkDataShape.length) {
            throw new ValueError(`Inconsistent shapes: chunkCoordsLength: ${chunkCoords.length}, cDataShapeLength: ${this.chunkDataShape.length}`);
        }
        const cKey = this.chunkKey(chunkCoords);
        try {
            const cdata = await this.chunkStore.getItem(cKey, storeOptions);
            const decodedChunk = await this.decodeChunk(cdata);
            if (out instanceof NestedArray) {
                if (isContiguousSelection(outSelection) && isTotalSlice(chunkSelection, this.chunks) && !this.meta.filters) {
                    // Optimization: we want the whole chunk, and the destination is
                    // contiguous, so we can decompress directly from the chunk
                    // into the destination array
                    // TODO check order
                    // TODO filters..
                    out.set(outSelection, this.toNestedArray(decodedChunk));
                    return;
                }
                // Decode chunk
                const chunk = this.toNestedArray(decodedChunk);
                const tmp = chunk.get(chunkSelection);
                if (dropAxes !== null) {
                    throw new Error("Drop axes is not supported yet");
                }
                out.set(outSelection, tmp);
            }
            else {
                /* RawArray
                Copies chunk by index directly into output. Doesn't matter if selection is contiguous
                since store/output are different shapes/strides.
                */
                out.set(outSelection, this.chunkBufferToRawArray(decodedChunk), chunkSelection);
            }
        }
        catch (error) {
            if (isKeyError(error)) {
                // fill with scalar if cKey doesn't exist in store
                if (this.fillValue !== null) {
                    out.set(outSelection, this.fillValue);
                }
            }
            else {
                // Different type of error - rethrow
                throw error;
            }
        }
    }
    async getRawChunk(chunkCoords, opts) {
        if (chunkCoords.length !== this.shape.length) {
            throw new Error(`Chunk coordinates ${chunkCoords.join(".")} do not correspond to shape ${this.shape}.`);
        }
        try {
            for (let i = 0; i < chunkCoords.length; i++) {
                const dimLength = Math.ceil(this.shape[i] / this.chunks[i]);
                chunkCoords[i] = normalizeIntegerSelection(chunkCoords[i], dimLength);
            }
        }
        catch (error) {
            if (error instanceof BoundsCheckError) {
                throw new BoundsCheckError(`index ${chunkCoords.join(".")} is out of bounds for shape: ${this.shape} and chunks ${this.chunks}`);
            }
            else {
                throw error;
            }
        }
        const cKey = this.chunkKey(chunkCoords);
        const cdata = this.chunkStore.getItem(cKey, opts === null || opts === void 0 ? void 0 : opts.storeOptions);
        const buffer = await this.decodeChunk(await cdata);
        const outShape = this.chunks.filter(d => d !== 1); // squeeze chunk dim if 1
        return new RawArray(buffer, outShape, this.dtype);
    }
    chunkKey(chunkCoords) {
        var _a;
        const sep = (_a = this.meta.dimension_separator) !== null && _a !== void 0 ? _a : ".";
        return this.keyPrefix + chunkCoords.join(sep);
    }
    ensureByteArray(chunkData) {
        if (typeof chunkData === "string") {
            return new Uint8Array(Buffer.from(chunkData).buffer);
        }
        return new Uint8Array(chunkData);
    }
    toTypedArray(buffer) {
        return new (getTypedArrayCtr(this.dtype))(buffer);
    }
    toNestedArray(data) {
        const buffer = this.ensureByteArray(data).buffer;
        return new NestedArray(buffer, this.chunks, this.dtype);
    }
    async decodeChunk(chunkData) {
        let bytes = this.ensureByteArray(chunkData);
        if (this.compressor !== null) {
            bytes = await (await this.compressor).decode(bytes);
        }
        if (this.dtype.includes('>')) {
            // Need to flip bytes for Javascript TypedArrays
            // We flip bytes in-place to avoid creating an extra copy of the decoded buffer.
            byteSwapInplace(this.toTypedArray(bytes.buffer));
        }
        if (this.meta.order === "F" && this.nDims > 1) {
            // We need to transpose the array, because this library only support C-order.
            const src = this.toTypedArray(bytes.buffer);
            const out = new (getTypedArrayCtr(this.dtype))(src.length);
            convertColMajorToRowMajor(src, out, this.chunks);
            return out.buffer;
        }
        // TODO filtering etc
        return bytes.buffer;
    }
    chunkBufferToRawArray(buffer) {
        return new RawArray(buffer, this.chunks, this.dtype);
    }
    async decodeDirectToRawArray({ chunkCoords }, outShape, outSize) {
        const cKey = this.chunkKey(chunkCoords);
        try {
            const cdata = await this.chunkStore.getItem(cKey);
            return new RawArray(await this.decodeChunk(cdata), outShape, this.dtype);
        }
        catch (error) {
            if (isKeyError(error)) {
                // fill with scalar if item doesn't exist
                const data = new (getTypedArrayCtr(this.dtype))(outSize);
                return new RawArray(data.fill(this.fillValue), outShape);
            }
            else {
                // Different type of error - rethrow
                throw error;
            }
        }
    }
    async set(selection = null, value, opts = {}) {
        await this.setBasicSelection(selection, value, opts);
    }
    async setBasicSelection(selection, value, { concurrencyLimit = 10, progressCallback } = {}) {
        if (this.readOnly) {
            throw new PermissionError("Object is read only");
        }
        if (!this.cacheMetadata) {
            await this.reloadMetadata();
        }
        if (this.shape.length === 0) {
            throw new Error("Shape [] indexing is not supported yet");
        }
        else {
            await this.setBasicSelectionND(selection, value, concurrencyLimit, progressCallback);
        }
    }
    async setBasicSelectionND(selection, value, concurrencyLimit, progressCallback) {
        const indexer = new BasicIndexer(selection, this);
        await this.setSelection(indexer, value, concurrencyLimit, progressCallback);
    }
    getChunkValue(proj, indexer, value, selectionShape) {
        let chunkValue;
        if (selectionShape.length === 0) {
            chunkValue = value;
        }
        else if (typeof value === "number") {
            chunkValue = value;
        }
        else {
            chunkValue = value.get(proj.outSelection);
            // tslint:disable-next-line: strict-type-predicates
            if (indexer.dropAxes !== null) {
                throw new Error("Handling drop axes not supported yet");
            }
        }
        return chunkValue;
    }
    async setSelection(indexer, value, concurrencyLimit, progressCallback) {
        // We iterate over all chunks which overlap the selection and thus contain data
        // that needs to be replaced. Each chunk is processed in turn, extracting the
        // necessary data from the value array and storing into the chunk array.
        // N.B., it is an important optimisation that we only visit chunks which overlap
        // the selection. This minimises the number of iterations in the main for loop.
        // TODO? check fields are sensible
        // Determine indices of chunks overlapping the selection
        const selectionShape = indexer.shape;
        // Check value shape
        if (selectionShape.length === 0) ;
        else if (typeof value === "number") ;
        else if (value instanceof NestedArray) {
            // TODO: non stringify equality check
            if (!arrayEquals1D(value.shape, selectionShape)) {
                throw new ValueError(`Shape mismatch in source NestedArray and set selection: ${value.shape} and ${selectionShape}`);
            }
        }
        else {
            // TODO support TypedArrays, buffers, etc
            throw new Error("Unknown data type for setting :(");
        }
        const queue = new PQueue({ concurrency: concurrencyLimit });
        const allTasks = [];
        if (progressCallback) {
            let queueSize = 0;
            for (const _ of indexer.iter())
                queueSize += 1;
            let progress = 0;
            progressCallback({ progress: 0, queueSize: queueSize });
            for (const proj of indexer.iter()) {
                const chunkValue = this.getChunkValue(proj, indexer, value, selectionShape);
                allTasks.push(queue.add(async () => {
                    await this.chunkSetItem(proj.chunkCoords, proj.chunkSelection, chunkValue);
                    progress += 1;
                    progressCallback({ progress: progress, queueSize: queueSize });
                }));
            }
        }
        else {
            for (const proj of indexer.iter()) {
                const chunkValue = this.getChunkValue(proj, indexer, value, selectionShape);
                allTasks.push(queue.add(() => this.chunkSetItem(proj.chunkCoords, proj.chunkSelection, chunkValue)));
            }
        }
        // guarantees that all work on queue has finished and throws if any of the tasks errored.
        await Promise.all(allTasks);
    }
    async chunkSetItem(chunkCoords, chunkSelection, value) {
        if (this.meta.order === "F" && this.nDims > 1) {
            throw new Error("Setting content for arrays in F-order is not supported.");
        }
        // Obtain key for chunk storage
        const chunkKey = this.chunkKey(chunkCoords);
        let chunk = null;
        const dtypeConstr = getTypedArrayCtr(this.dtype);
        const chunkSize = this.chunkSize;
        if (isTotalSlice(chunkSelection, this.chunks)) {
            // Totally replace chunk
            // Optimization: we are completely replacing the chunk, so no need
            // to access the existing chunk data
            if (typeof value === "number") {
                // TODO get the right type here
                chunk = new dtypeConstr(chunkSize);
                chunk.fill(value);
            }
            else {
                chunk = value.flatten();
            }
        }
        else {
            // partially replace the contents of this chunk
            // Existing chunk data
            let chunkData;
            try {
                // Chunk is initialized if this does not error
                const chunkStoreData = await this.chunkStore.getItem(chunkKey);
                const dBytes = await this.decodeChunk(chunkStoreData);
                chunkData = this.toTypedArray(dBytes);
            }
            catch (error) {
                if (isKeyError(error)) {
                    // Chunk is not initialized
                    chunkData = new dtypeConstr(chunkSize);
                    if (this.fillValue !== null) {
                        chunkData.fill(this.fillValue);
                    }
                }
                else {
                    // Different type of error - rethrow
                    throw error;
                }
            }
            const chunkNestedArray = new NestedArray(chunkData, this.chunks, this.dtype);
            chunkNestedArray.set(chunkSelection, value);
            chunk = chunkNestedArray.flatten();
        }
        const chunkData = await this.encodeChunk(chunk);
        this.chunkStore.setItem(chunkKey, chunkData);
    }
    async encodeChunk(chunk) {
        if (this.dtype.includes('>')) {
            /*
             * If big endian, flip bytes before applying compression and setting store.
             *
             * Here we create a copy (not in-place byteswapping) to avoid flipping the
             * bytes in the buffers of user-created Raw- and NestedArrays.
            */
            chunk = byteSwap(chunk);
        }
        if (this.compressor !== null) {
            const bytes = new Uint8Array(chunk.buffer);
            const cbytes = await (await this.compressor).encode(bytes);
            return cbytes.buffer;
        }
        // TODO: filters, etc
        return chunk.buffer;
    }
}

class MemoryStore {
    constructor(root = {}) {
        this.root = root;
    }
    proxy() {
        return createProxy(this);
    }
    getParent(item) {
        let parent = this.root;
        const segments = item.split('/');
        // find the parent container
        for (const k of segments.slice(0, segments.length - 1)) {
            parent = parent[k];
            if (!parent) {
                throw Error(item);
            }
            // if not isinstance(parent, self.cls):
            //     raise KeyError(item)
        }
        return [parent, segments[segments.length - 1]];
    }
    requireParent(item) {
        let parent = this.root;
        const segments = item.split('/');
        // require the parent container
        for (const k of segments.slice(0, segments.length - 1)) {
            // TODO: verify correct implementation
            if (parent[k] === undefined) {
                parent[k] = {};
            }
            parent = parent[k];
        }
        return [parent, segments[segments.length - 1]];
    }
    getItem(item) {
        const [parent, key] = this.getParent(item);
        const value = parent[key];
        if (value === undefined) {
            throw new KeyError(item);
        }
        return value;
    }
    setItem(item, value) {
        const [parent, key] = this.requireParent(item);
        parent[key] = value;
        return true;
    }
    deleteItem(item) {
        const [parent, key] = this.getParent(item);
        return delete parent[key];
    }
    containsItem(item) {
        // TODO: more sane implementation
        try {
            return this.getItem(item) !== undefined;
        }
        catch (e) {
            return false;
        }
    }
    keys() {
        throw new Error("Method not implemented.");
    }
}

var HTTPMethod;
(function (HTTPMethod) {
    HTTPMethod["HEAD"] = "HEAD";
    HTTPMethod["GET"] = "GET";
    HTTPMethod["PUT"] = "PUT";
})(HTTPMethod || (HTTPMethod = {}));
const DEFAULT_METHODS = [HTTPMethod.HEAD, HTTPMethod.GET, HTTPMethod.PUT];
class HTTPStore {
    constructor(url, options = {}) {
        this.url = url;
        const { fetchOptions = {}, supportedMethods = DEFAULT_METHODS } = options;
        this.fetchOptions = fetchOptions;
        this.supportedMethods = new Set(supportedMethods);
    }
    keys() {
        throw new Error('Method not implemented.');
    }
    async getItem(item, opts) {
        const url = resolveUrl(this.url, item);
        const value = await fetch(url, { ...this.fetchOptions, ...opts });
        if (value.status === 404) {
            // Item is not found
            throw new KeyError(item);
        }
        else if (value.status !== 200) {
            throw new HTTPError(String(value.status));
        }
        // only decode if 200
        if (IS_NODE) {
            return Buffer.from(await value.arrayBuffer());
        }
        else {
            return value.arrayBuffer(); // Browser
        }
    }
    async setItem(item, value) {
        if (!this.supportedMethods.has(HTTPMethod.PUT)) {
            throw new Error('HTTP PUT no a supported method for store.');
        }
        const url = resolveUrl(this.url, item);
        if (typeof value === 'string') {
            value = new TextEncoder().encode(value).buffer;
        }
        const set = await fetch(url, { ...this.fetchOptions, method: HTTPMethod.PUT, body: value });
        return set.status.toString()[0] === '2';
    }
    deleteItem(_item) {
        throw new Error('Method not implemented.');
    }
    async containsItem(item) {
        const url = resolveUrl(this.url, item);
        // Just check headers if HEAD method supported
        const method = this.supportedMethods.has(HTTPMethod.HEAD) ? HTTPMethod.HEAD : HTTPMethod.GET;
        const value = await fetch(url, { ...this.fetchOptions, method });
        return value.status === 200;
    }
}

/**
 *
 * @param shape Array shape.
 * @param chunks  Chunk shape. If `true`, will be guessed from `shape` and `dtype`. If
 *      `false`, will be set to `shape`, i.e., single chunk for the whole array.
 *      If an int, the chunk size in each dimension will be given by the value
 *      of `chunks`. Default is `true`.
 * @param dtype NumPy dtype.
 * @param compressor Primary compressor.
 * @param fillValue Default value to use for uninitialized portions of the array.
 * @param order Memory layout to be used within each chunk.
 * @param store Store or path to directory in file system or name of zip file.
 * @param overwrite  If True, delete all pre-existing data in `store` at `path` before creating the array.
 * @param path Path under which array is stored.
 * @param chunkStore Separate storage for chunks. If not provided, `store` will be used for storage of both chunks and metadata.
 * @param filters Sequence of filters to use to encode chunk data prior to compression.
 * @param cacheMetadata If `true` (default), array configuration metadata will be cached for the
 *      lifetime of the object. If `false`, array metadata will be reloaded
 *      prior to all data access and modification operations (may incur
 *      overhead depending on storage and data access pattern).
 * @param cacheAttrs If `true` (default), user attributes will be cached for attribute read
 *      operations. If `false`, user attributes are reloaded from the store prior
 *      to all attribute read operations.
 * @param readOnly `true` if array should be protected against modification, defaults to `false`.
 * @param dimensionSeparator if specified, defines an alternate string separator placed between the dimension chunks.
 */
async function create({ shape, chunks = true, dtype = "<i4", compressor = null, fillValue = null, order = "C", store: storeArgument, overwrite = false, path, chunkStore, filters, cacheMetadata = true, cacheAttrs = true, readOnly = false, dimensionSeparator }) {
    const store = normalizeStoreArgument(storeArgument);
    await initArray(store, shape, chunks, dtype, path, compressor, fillValue, order, overwrite, chunkStore, filters, dimensionSeparator);
    const z = await ZarrArray.create(store, path, readOnly, chunkStore, cacheMetadata, cacheAttrs);
    return z;
}
/**
 * Create an empty array.
 */
async function empty(shape, opts = {}) {
    opts.fillValue = null;
    return create({ shape, ...opts });
}
/**
 * Create an array, with zero being used as the default value for
 * uninitialized portions of the array.
 */
async function zeros(shape, opts = {}) {
    opts.fillValue = 0;
    return create({ shape, ...opts });
}
/**
 * Create an array, with one being used as the default value for
 * uninitialized portions of the array.
 */
async function ones(shape, opts = {}) {
    opts.fillValue = 1;
    return create({ shape, ...opts });
}
/**
 * Create an array, with `fill_value` being used as the default value for
 * uninitialized portions of the array
 */
async function full(shape, fillValue, opts = {}) {
    opts.fillValue = fillValue;
    return create({ shape, ...opts });
}
async function array(data, opts = {}) {
    // TODO: infer chunks?
    let shape = null;
    if (data instanceof NestedArray) {
        shape = data.shape;
        opts.dtype = opts.dtype === undefined ? data.dtype : opts.dtype;
    }
    else {
        shape = data.byteLength;
        // TODO: infer datatype
    }
    // TODO: support TypedArray
    const wasReadOnly = opts.readOnly === undefined ? false : opts.readOnly;
    opts.readOnly = false;
    const z = await create({ shape, ...opts });
    await z.set(null, data);
    z.readOnly = wasReadOnly;
    return z;
}
async function openArray({ shape, mode = "a", chunks = true, dtype = "<i4", compressor = null, fillValue = null, order = "C", store: storeArgument, overwrite = false, path = null, chunkStore, filters, cacheMetadata = true, cacheAttrs = true, dimensionSeparator } = {}) {
    const store = normalizeStoreArgument(storeArgument);
    if (chunkStore === undefined) {
        chunkStore = normalizeStoreArgument(store);
    }
    path = normalizeStoragePath(path);
    if (mode === "r" || mode === "r+") {
        if (!await containsArray(store, path)) {
            if (await containsGroup(store, path)) {
                throw new ContainsGroupError(path);
            }
            throw new ArrayNotFoundError(path);
        }
    }
    else if (mode === "w") {
        if (shape === undefined) {
            throw new ValueError("Shape can not be undefined when creating a new array");
        }
        await initArray(store, shape, chunks, dtype, path, compressor, fillValue, order, overwrite, chunkStore, filters, dimensionSeparator);
    }
    else if (mode === "a") {
        if (!await containsArray(store, path)) {
            if (await containsGroup(store, path)) {
                throw new ContainsGroupError(path);
            }
            if (shape === undefined) {
                throw new ValueError("Shape can not be undefined when creating a new array");
            }
            await initArray(store, shape, chunks, dtype, path, compressor, fillValue, order, overwrite, chunkStore, filters, dimensionSeparator);
        }
    }
    else if (mode === "w-" || mode === "x") {
        if (await containsArray(store, path)) {
            throw new ContainsArrayError(path);
        }
        else if (await containsGroup(store, path)) {
            throw new ContainsGroupError(path);
        }
        else {
            if (shape === undefined) {
                throw new ValueError("Shape can not be undefined when creating a new array");
            }
            await initArray(store, shape, chunks, dtype, path, compressor, fillValue, order, overwrite, chunkStore, filters, dimensionSeparator);
        }
    }
    else {
        throw new ValueError(`Invalid mode argument: ${mode}`);
    }
    const readOnly = mode === "r";
    return ZarrArray.create(store, path, readOnly, chunkStore, cacheMetadata, cacheAttrs);
}
function normalizeStoreArgument(store) {
    if (store === undefined) {
        return new MemoryStore();
    }
    else if (typeof store === "string") {
        return new HTTPStore(store);
    }
    return store;
}

class Group {
    constructor(store, path = null, metadata, readOnly = false, chunkStore = null, cacheAttrs = true) {
        this.store = store;
        this._chunkStore = chunkStore;
        this.path = normalizeStoragePath(path);
        this.keyPrefix = pathToPrefix(this.path);
        this.readOnly = readOnly;
        this.meta = metadata;
        // Initialize attributes
        const attrKey = this.keyPrefix + ATTRS_META_KEY;
        this.attrs = new Attributes(this.store, attrKey, this.readOnly, cacheAttrs);
    }
    /**
     * Group name following h5py convention.
     */
    get name() {
        if (this.path.length > 0) {
            if (this.path[0] !== "/") {
                return "/" + this.path;
            }
            return this.path;
        }
        return "/";
    }
    /**
     * Final component of name.
     */
    get basename() {
        const parts = this.name.split("/");
        return parts[parts.length - 1];
    }
    /**
     * A `Store` providing the underlying storage for array chunks.
     */
    get chunkStore() {
        if (this._chunkStore) {
            return this._chunkStore;
        }
        return this.store;
    }
    static async create(store, path = null, readOnly = false, chunkStore = null, cacheAttrs = true) {
        const metadata = await this.loadMetadataForConstructor(store, path);
        return new Group(store, path, metadata, readOnly, chunkStore, cacheAttrs);
    }
    static async loadMetadataForConstructor(store, path) {
        path = normalizeStoragePath(path);
        const keyPrefix = pathToPrefix(path);
        try {
            const metaStoreValue = await store.getItem(keyPrefix + GROUP_META_KEY);
            return parseMetadata(metaStoreValue);
        }
        catch (error) {
            if (await containsArray(store, path)) {
                throw new ContainsArrayError(path);
            }
            throw new GroupNotFoundError(path);
        }
    }
    itemPath(item) {
        const absolute = typeof item === "string" && item.length > 0 && item[0] === '/';
        const path = normalizeStoragePath(item);
        // Absolute path
        if (!absolute && this.path.length > 0) {
            return this.keyPrefix + path;
        }
        return path;
    }
    /**
     * Create a sub-group.
     */
    async createGroup(name, overwrite = false) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        const path = this.itemPath(name);
        await initGroup(this.store, path, this._chunkStore, overwrite);
        return Group.create(this.store, path, this.readOnly, this._chunkStore, this.attrs.cache);
    }
    /**
     * Obtain a sub-group, creating one if it doesn't exist.
     */
    async requireGroup(name, overwrite = false) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        const path = this.itemPath(name);
        if (!await containsGroup(this.store, path)) {
            await initGroup(this.store, path, this._chunkStore, overwrite);
        }
        return Group.create(this.store, path, this.readOnly, this._chunkStore, this.attrs.cache);
    }
    getOptsForArrayCreation(name, opts = {}) {
        const path = this.itemPath(name);
        opts.path = path;
        if (opts.cacheAttrs === undefined) {
            opts.cacheAttrs = this.attrs.cache;
        }
        opts.store = this.store;
        opts.chunkStore = this.chunkStore;
        return opts;
    }
    /**
     * Creates an array
     */
    array(name, data, opts, overwrite) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        opts = this.getOptsForArrayCreation(name, opts);
        opts.overwrite = overwrite === undefined ? opts.overwrite : overwrite;
        return array(data, opts);
    }
    empty(name, shape, opts = {}) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        opts = this.getOptsForArrayCreation(name, opts);
        return empty(shape, opts);
    }
    zeros(name, shape, opts = {}) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        opts = this.getOptsForArrayCreation(name, opts);
        return zeros(shape, opts);
    }
    ones(name, shape, opts = {}) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        opts = this.getOptsForArrayCreation(name, opts);
        return ones(shape, opts);
    }
    full(name, shape, fillValue, opts = {}) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        opts = this.getOptsForArrayCreation(name, opts);
        return full(shape, fillValue, opts);
    }
    createDataset(name, shape, data, opts) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        opts = this.getOptsForArrayCreation(name, opts);
        let z;
        if (data === undefined) {
            if (shape === undefined) {
                throw new ValueError("Shape must be set if no data is passed to CreateDataset");
            }
            z = create({ shape, ...opts });
        }
        else {
            z = array(data, opts);
        }
        return z;
    }
    async getItem(item) {
        const path = this.itemPath(item);
        if (await containsArray(this.store, path)) {
            return ZarrArray.create(this.store, path, this.readOnly, this.chunkStore, undefined, this.attrs.cache);
        }
        else if (await containsGroup(this.store, path)) {
            return Group.create(this.store, path, this.readOnly, this._chunkStore, this.attrs.cache);
        }
        throw new KeyError(item);
    }
    async setItem(item, value) {
        await this.array(item, value, {}, true);
        return true;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async deleteItem(_item) {
        if (this.readOnly) {
            throw new PermissionError("group is read only");
        }
        throw new Error("Method not implemented.");
    }
    async containsItem(item) {
        const path = this.itemPath(item);
        return await containsArray(this.store, path) || containsGroup(this.store, path);
    }
    proxy() {
        return createProxy(this);
    }
}
/**
 * Create a group.
 * @param store Store or path to directory in file system.
 * @param path Group path within store.
 * @param chunkStore Separate storage for chunks. If not provided, `store` will be used for storage of both chunks and metadata.
 * @param overwrite If `true`, delete any pre-existing data in `store` at `path` before creating the group.
 * @param cacheAttrs If `true` (default), user attributes will be cached for attribute read operations.
 *   If `false`, user attributes are reloaded from the store prior to all attribute read operations.
 */
async function group(store, path = null, chunkStore, overwrite = false, cacheAttrs = true) {
    store = normalizeStoreArgument(store);
    path = normalizeStoragePath(path);
    if (overwrite || await containsGroup(store)) {
        await initGroup(store, path, chunkStore, overwrite);
    }
    return Group.create(store, path, false, chunkStore, cacheAttrs);
}
/**
 * Open a group using file-mode-like semantics.
 * @param store Store or path to directory in file system or name of zip file.
 * @param path Group path within store.
 * @param mode Persistence mode, see `PersistenceMode` type.
 * @param chunkStore Store or path to directory in file system or name of zip file.
 * @param cacheAttrs If `true` (default), user attributes will be cached for attribute read operations
 *   If False, user attributes are reloaded from the store prior to all attribute read operations.
 *
 */
async function openGroup(store, path = null, mode = "a", chunkStore, cacheAttrs = true) {
    store = normalizeStoreArgument(store);
    if (chunkStore !== undefined) {
        chunkStore = normalizeStoreArgument(store);
    }
    path = normalizeStoragePath(path);
    if (mode === "r" || mode === "r+") {
        if (!await containsGroup(store, path)) {
            if (await containsArray(store, path)) {
                throw new ContainsArrayError(path);
            }
            throw new GroupNotFoundError(path);
        }
    }
    else if (mode === "w") {
        await initGroup(store, path, chunkStore, true);
    }
    else if (mode === "a") {
        if (!await containsGroup(store, path)) {
            if (await containsArray(store, path)) {
                throw new ContainsArrayError(path);
            }
            await initGroup(store, path, chunkStore);
        }
    }
    else if (mode === "w-" || mode === "x") {
        if (await containsArray(store, path)) {
            throw new ContainsArrayError(path);
        }
        else if (await containsGroup(store, path)) {
            throw new ContainsGroupError(path);
        }
        else {
            await initGroup(store, path, chunkStore);
        }
    }
    else {
        throw new ValueError(`Invalid mode argument: ${mode}`);
    }
    const readOnly = mode === "r";
    return Group.create(store, path, readOnly, chunkStore, cacheAttrs);
}

class ObjectStore {
    constructor() {
        this.object = {};
    }
    getItem(item) {
        if (!Object.prototype.hasOwnProperty.call(this.object, item)) {
            throw new KeyError(item);
        }
        return this.object[item];
    }
    setItem(item, value) {
        this.object[item] = value;
        return true;
    }
    deleteItem(item) {
        return delete this.object[item];
    }
    containsItem(item) {
        return Object.prototype.hasOwnProperty.call(this.object, item);
    }
    proxy() {
        return createProxy(this);
    }
    keys() {
        return Object.getOwnPropertyNames(this.object);
    }
}

const getHttpHandlerExtensionConfiguration = (runtimeConfig) => {
    let httpHandler = runtimeConfig.httpHandler;
    return {
        setHttpHandler(handler) {
            httpHandler = handler;
        },
        httpHandler() {
            return httpHandler;
        },
        updateHttpClientConfig(key, value) {
            httpHandler.updateHttpClientConfig(key, value);
        },
        httpHandlerConfigs() {
            return httpHandler.httpHandlerConfigs();
        },
    };
};
const resolveHttpHandlerRuntimeConfig = (httpHandlerExtensionConfiguration) => {
    return {
        httpHandler: httpHandlerExtensionConfiguration.httpHandler(),
    };
};

var HttpAuthLocation;
(function (HttpAuthLocation) {
    HttpAuthLocation["HEADER"] = "header";
    HttpAuthLocation["QUERY"] = "query";
})(HttpAuthLocation || (HttpAuthLocation = {}));

var HttpApiKeyAuthLocation;
(function (HttpApiKeyAuthLocation) {
    HttpApiKeyAuthLocation["HEADER"] = "header";
    HttpApiKeyAuthLocation["QUERY"] = "query";
})(HttpApiKeyAuthLocation || (HttpApiKeyAuthLocation = {}));

var EndpointURLScheme;
(function (EndpointURLScheme) {
    EndpointURLScheme["HTTP"] = "http";
    EndpointURLScheme["HTTPS"] = "https";
})(EndpointURLScheme || (EndpointURLScheme = {}));

var AlgorithmId;
(function (AlgorithmId) {
    AlgorithmId["MD5"] = "md5";
    AlgorithmId["CRC32"] = "crc32";
    AlgorithmId["CRC32C"] = "crc32c";
    AlgorithmId["SHA1"] = "sha1";
    AlgorithmId["SHA256"] = "sha256";
})(AlgorithmId || (AlgorithmId = {}));

var FieldPosition;
(function (FieldPosition) {
    FieldPosition[FieldPosition["HEADER"] = 0] = "HEADER";
    FieldPosition[FieldPosition["TRAILER"] = 1] = "TRAILER";
})(FieldPosition || (FieldPosition = {}));

const SMITHY_CONTEXT_KEY = "__smithy_context";

var IniSectionType;
(function (IniSectionType) {
    IniSectionType["PROFILE"] = "profile";
    IniSectionType["SSO_SESSION"] = "sso-session";
    IniSectionType["SERVICES"] = "services";
})(IniSectionType || (IniSectionType = {}));

var RequestHandlerProtocol;
(function (RequestHandlerProtocol) {
    RequestHandlerProtocol["HTTP_0_9"] = "http/0.9";
    RequestHandlerProtocol["HTTP_1_0"] = "http/1.0";
    RequestHandlerProtocol["TDS_8_0"] = "tds/8.0";
})(RequestHandlerProtocol || (RequestHandlerProtocol = {}));

class HttpRequest {
    constructor(options) {
        this.method = options.method || "GET";
        this.hostname = options.hostname || "localhost";
        this.port = options.port;
        this.query = options.query || {};
        this.headers = options.headers || {};
        this.body = options.body;
        this.protocol = options.protocol
            ? options.protocol.slice(-1) !== ":"
                ? `${options.protocol}:`
                : options.protocol
            : "https:";
        this.path = options.path ? (options.path.charAt(0) !== "/" ? `/${options.path}` : options.path) : "/";
        this.username = options.username;
        this.password = options.password;
        this.fragment = options.fragment;
    }
    static clone(request) {
        const cloned = new HttpRequest({
            ...request,
            headers: { ...request.headers },
        });
        if (cloned.query) {
            cloned.query = cloneQuery(cloned.query);
        }
        return cloned;
    }
    static isInstance(request) {
        if (!request) {
            return false;
        }
        const req = request;
        return ("method" in req &&
            "protocol" in req &&
            "hostname" in req &&
            "path" in req &&
            typeof req["query"] === "object" &&
            typeof req["headers"] === "object");
    }
    clone() {
        return HttpRequest.clone(this);
    }
}
function cloneQuery(query) {
    return Object.keys(query).reduce((carry, paramName) => {
        const param = query[paramName];
        return {
            ...carry,
            [paramName]: Array.isArray(param) ? [...param] : param,
        };
    }, {});
}

class HttpResponse {
    constructor(options) {
        this.statusCode = options.statusCode;
        this.reason = options.reason;
        this.headers = options.headers || {};
        this.body = options.body;
    }
    static isInstance(response) {
        if (!response)
            return false;
        const resp = response;
        return typeof resp.statusCode === "number" && typeof resp.headers === "object";
    }
}

function addExpectContinueMiddleware(options) {
    return (next) => async (args) => {
        const { request } = args;
        if (HttpRequest.isInstance(request) && request.body && options.runtime === "node") {
            if (options.requestHandler?.constructor?.name !== "FetchHttpHandler") {
                request.headers = {
                    ...request.headers,
                    Expect: "100-continue",
                };
            }
        }
        return next({
            ...args,
            request,
        });
    };
}
const addExpectContinueMiddlewareOptions = {
    step: "build",
    tags: ["SET_EXPECT_HEADER", "EXPECT_HEADER"],
    name: "addExpectContinueMiddleware",
    override: true,
};
const getAddExpectContinuePlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(addExpectContinueMiddleware(options), addExpectContinueMiddlewareOptions);
    },
});

const RequestChecksumCalculation = {
    WHEN_SUPPORTED: "WHEN_SUPPORTED",
    WHEN_REQUIRED: "WHEN_REQUIRED",
};
const DEFAULT_REQUEST_CHECKSUM_CALCULATION = RequestChecksumCalculation.WHEN_SUPPORTED;
const ResponseChecksumValidation = {
    WHEN_SUPPORTED: "WHEN_SUPPORTED",
    WHEN_REQUIRED: "WHEN_REQUIRED",
};
const DEFAULT_RESPONSE_CHECKSUM_VALIDATION = RequestChecksumCalculation.WHEN_SUPPORTED;
var ChecksumAlgorithm;
(function (ChecksumAlgorithm) {
    ChecksumAlgorithm["MD5"] = "MD5";
    ChecksumAlgorithm["CRC32"] = "CRC32";
    ChecksumAlgorithm["CRC32C"] = "CRC32C";
    ChecksumAlgorithm["CRC64NVME"] = "CRC64NVME";
    ChecksumAlgorithm["SHA1"] = "SHA1";
    ChecksumAlgorithm["SHA256"] = "SHA256";
})(ChecksumAlgorithm || (ChecksumAlgorithm = {}));
var ChecksumLocation;
(function (ChecksumLocation) {
    ChecksumLocation["HEADER"] = "header";
    ChecksumLocation["TRAILER"] = "trailer";
})(ChecksumLocation || (ChecksumLocation = {}));
const DEFAULT_CHECKSUM_ALGORITHM = ChecksumAlgorithm.CRC32;

var SelectorType$1;
(function (SelectorType) {
    SelectorType["ENV"] = "env";
    SelectorType["CONFIG"] = "shared config entry";
})(SelectorType$1 || (SelectorType$1 = {}));
const stringUnionSelector = (obj, key, union, type) => {
    if (!(key in obj))
        return undefined;
    const value = obj[key].toUpperCase();
    if (!Object.values(union).includes(value)) {
        throw new TypeError(`Cannot load ${type} '${key}'. Expected one of ${Object.values(union)}, got '${obj[key]}'.`);
    }
    return value;
};

const ENV_REQUEST_CHECKSUM_CALCULATION = "AWS_REQUEST_CHECKSUM_CALCULATION";
const CONFIG_REQUEST_CHECKSUM_CALCULATION = "request_checksum_calculation";
const NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => stringUnionSelector(env, ENV_REQUEST_CHECKSUM_CALCULATION, RequestChecksumCalculation, SelectorType$1.ENV),
    configFileSelector: (profile) => stringUnionSelector(profile, CONFIG_REQUEST_CHECKSUM_CALCULATION, RequestChecksumCalculation, SelectorType$1.CONFIG),
    default: DEFAULT_REQUEST_CHECKSUM_CALCULATION,
};

const ENV_RESPONSE_CHECKSUM_VALIDATION = "AWS_RESPONSE_CHECKSUM_VALIDATION";
const CONFIG_RESPONSE_CHECKSUM_VALIDATION = "response_checksum_validation";
const NODE_RESPONSE_CHECKSUM_VALIDATION_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => stringUnionSelector(env, ENV_RESPONSE_CHECKSUM_VALIDATION, ResponseChecksumValidation, SelectorType$1.ENV),
    configFileSelector: (profile) => stringUnionSelector(profile, CONFIG_RESPONSE_CHECKSUM_VALIDATION, ResponseChecksumValidation, SelectorType$1.CONFIG),
    default: DEFAULT_RESPONSE_CHECKSUM_VALIDATION,
};

const state = {
    warningEmitted: false,
};
const emitWarningIfUnsupportedVersion$1 = (version) => {
    if (version && !state.warningEmitted && parseInt(version.substring(1, version.indexOf("."))) < 18) {
        state.warningEmitted = true;
        process.emitWarning(`NodeDeprecationWarning: The AWS SDK for JavaScript (v3) will
no longer support Node.js 16.x on January 6, 2025.

To continue receiving updates to AWS services, bug fixes, and security
updates please upgrade to a supported Node.js LTS version.

More information can be found at: https://a.co/74kJMmI`);
    }
};

function setCredentialFeature(credentials, feature, value) {
    if (!credentials.$source) {
        credentials.$source = {};
    }
    credentials.$source[feature] = value;
    return credentials;
}

function setFeature$1(context, feature, value) {
    if (!context.__aws_sdk_context) {
        context.__aws_sdk_context = {
            features: {},
        };
    }
    else if (!context.__aws_sdk_context.features) {
        context.__aws_sdk_context.features = {};
    }
    context.__aws_sdk_context.features[feature] = value;
}

const getDateHeader = (response) => HttpResponse.isInstance(response) ? response.headers?.date ?? response.headers?.Date : undefined;

const getSkewCorrectedDate = (systemClockOffset) => new Date(Date.now() + systemClockOffset);

const isClockSkewed = (clockTime, systemClockOffset) => Math.abs(getSkewCorrectedDate(systemClockOffset).getTime() - clockTime) >= 300000;

const getUpdatedSystemClockOffset = (clockTime, currentSystemClockOffset) => {
    const clockTimeInMs = Date.parse(clockTime);
    if (isClockSkewed(clockTimeInMs, currentSystemClockOffset)) {
        return clockTimeInMs - Date.now();
    }
    return currentSystemClockOffset;
};

const throwSigningPropertyError = (name, property) => {
    if (!property) {
        throw new Error(`Property \`${name}\` is not resolved for AWS SDK SigV4Auth`);
    }
    return property;
};
const validateSigningProperties = async (signingProperties) => {
    const context = throwSigningPropertyError("context", signingProperties.context);
    const config = throwSigningPropertyError("config", signingProperties.config);
    const authScheme = context.endpointV2?.properties?.authSchemes?.[0];
    const signerFunction = throwSigningPropertyError("signer", config.signer);
    const signer = await signerFunction(authScheme);
    const signingRegion = signingProperties?.signingRegion;
    const signingRegionSet = signingProperties?.signingRegionSet;
    const signingName = signingProperties?.signingName;
    return {
        config,
        signer,
        signingRegion,
        signingRegionSet,
        signingName,
    };
};
class AwsSdkSigV4Signer {
    async sign(httpRequest, identity, signingProperties) {
        if (!HttpRequest.isInstance(httpRequest)) {
            throw new Error("The request is not an instance of `HttpRequest` and cannot be signed");
        }
        const validatedProps = await validateSigningProperties(signingProperties);
        const { config, signer } = validatedProps;
        let { signingRegion, signingName } = validatedProps;
        const handlerExecutionContext = signingProperties.context;
        if (handlerExecutionContext?.authSchemes?.length ?? 0 > 1) {
            const [first, second] = handlerExecutionContext.authSchemes;
            if (first?.name === "sigv4a" && second?.name === "sigv4") {
                signingRegion = second?.signingRegion ?? signingRegion;
                signingName = second?.signingName ?? signingName;
            }
        }
        const signedRequest = await signer.sign(httpRequest, {
            signingDate: getSkewCorrectedDate(config.systemClockOffset),
            signingRegion: signingRegion,
            signingService: signingName,
        });
        return signedRequest;
    }
    errorHandler(signingProperties) {
        return (error) => {
            const serverTime = error.ServerTime ?? getDateHeader(error.$response);
            if (serverTime) {
                const config = throwSigningPropertyError("config", signingProperties.config);
                const initialSystemClockOffset = config.systemClockOffset;
                config.systemClockOffset = getUpdatedSystemClockOffset(serverTime, config.systemClockOffset);
                const clockSkewCorrected = config.systemClockOffset !== initialSystemClockOffset;
                if (clockSkewCorrected && error.$metadata) {
                    error.$metadata.clockSkewCorrected = true;
                }
            }
            throw error;
        };
    }
    successHandler(httpResponse, signingProperties) {
        const dateHeader = getDateHeader(httpResponse);
        if (dateHeader) {
            const config = throwSigningPropertyError("config", signingProperties.config);
            config.systemClockOffset = getUpdatedSystemClockOffset(dateHeader, config.systemClockOffset);
        }
    }
}

class AwsSdkSigV4ASigner extends AwsSdkSigV4Signer {
    async sign(httpRequest, identity, signingProperties) {
        if (!HttpRequest.isInstance(httpRequest)) {
            throw new Error("The request is not an instance of `HttpRequest` and cannot be signed");
        }
        const { config, signer, signingRegion, signingRegionSet, signingName } = await validateSigningProperties(signingProperties);
        const configResolvedSigningRegionSet = await config.sigv4aSigningRegionSet?.();
        const multiRegionOverride = (configResolvedSigningRegionSet ??
            signingRegionSet ?? [signingRegion]).join(",");
        const signedRequest = await signer.sign(httpRequest, {
            signingDate: getSkewCorrectedDate(config.systemClockOffset),
            signingRegion: multiRegionOverride,
            signingService: signingName,
        });
        return signedRequest;
    }
}

const getSmithyContext = (context) => context[SMITHY_CONTEXT_KEY] || (context[SMITHY_CONTEXT_KEY] = {});

const normalizeProvider$1 = (input) => {
    if (typeof input === "function")
        return input;
    const promisified = Promise.resolve(input);
    return () => promisified;
};

function convertHttpAuthSchemesToMap(httpAuthSchemes) {
    const map = new Map();
    for (const scheme of httpAuthSchemes) {
        map.set(scheme.schemeId, scheme);
    }
    return map;
}
const httpAuthSchemeMiddleware = (config, mwOptions) => (next, context) => async (args) => {
    const options = config.httpAuthSchemeProvider(await mwOptions.httpAuthSchemeParametersProvider(config, context, args.input));
    const authSchemes = convertHttpAuthSchemesToMap(config.httpAuthSchemes);
    const smithyContext = getSmithyContext(context);
    const failureReasons = [];
    for (const option of options) {
        const scheme = authSchemes.get(option.schemeId);
        if (!scheme) {
            failureReasons.push(`HttpAuthScheme \`${option.schemeId}\` was not enabled for this service.`);
            continue;
        }
        const identityProvider = scheme.identityProvider(await mwOptions.identityProviderConfigProvider(config));
        if (!identityProvider) {
            failureReasons.push(`HttpAuthScheme \`${option.schemeId}\` did not have an IdentityProvider configured.`);
            continue;
        }
        const { identityProperties = {}, signingProperties = {} } = option.propertiesExtractor?.(config, context) || {};
        option.identityProperties = Object.assign(option.identityProperties || {}, identityProperties);
        option.signingProperties = Object.assign(option.signingProperties || {}, signingProperties);
        smithyContext.selectedHttpAuthScheme = {
            httpAuthOption: option,
            identity: await identityProvider(option.identityProperties),
            signer: scheme.signer,
        };
        break;
    }
    if (!smithyContext.selectedHttpAuthScheme) {
        throw new Error(failureReasons.join("\n"));
    }
    return next(args);
};

const httpAuthSchemeEndpointRuleSetMiddlewareOptions = {
    step: "serialize",
    tags: ["HTTP_AUTH_SCHEME"],
    name: "httpAuthSchemeMiddleware",
    override: true,
    relation: "before",
    toMiddleware: "endpointV2Middleware",
};
const getHttpAuthSchemeEndpointRuleSetPlugin = (config, { httpAuthSchemeParametersProvider, identityProviderConfigProvider, }) => ({
    applyToStack: (clientStack) => {
        clientStack.addRelativeTo(httpAuthSchemeMiddleware(config, {
            httpAuthSchemeParametersProvider,
            identityProviderConfigProvider,
        }), httpAuthSchemeEndpointRuleSetMiddlewareOptions);
    },
});

const deserializerMiddleware = (options, deserializer) => (next, context) => async (args) => {
    const { response } = await next(args);
    try {
        const parsed = await deserializer(response, options);
        return {
            response,
            output: parsed,
        };
    }
    catch (error) {
        Object.defineProperty(error, "$response", {
            value: response,
        });
        if (!("$metadata" in error)) {
            const hint = `Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.`;
            try {
                error.message += "\n  " + hint;
            }
            catch (e) {
                if (!context.logger || context.logger?.constructor?.name === "NoOpLogger") {
                    console.warn(hint);
                }
                else {
                    context.logger?.warn?.(hint);
                }
            }
            if (typeof error.$responseBodyText !== "undefined") {
                if (error.$response) {
                    error.$response.body = error.$responseBodyText;
                }
            }
        }
        throw error;
    }
};

const serializerMiddleware = (options, serializer) => (next, context) => async (args) => {
    const endpoint = context.endpointV2?.url && options.urlParser
        ? async () => options.urlParser(context.endpointV2.url)
        : options.endpoint;
    if (!endpoint) {
        throw new Error("No valid endpoint provider available.");
    }
    const request = await serializer(args.input, { ...options, endpoint });
    return next({
        ...args,
        request,
    });
};

const deserializerMiddlewareOption = {
    name: "deserializerMiddleware",
    step: "deserialize",
    tags: ["DESERIALIZER"],
    override: true,
};
const serializerMiddlewareOption = {
    name: "serializerMiddleware",
    step: "serialize",
    tags: ["SERIALIZER"],
    override: true,
};
function getSerdePlugin(config, serializer, deserializer) {
    return {
        applyToStack: (commandStack) => {
            commandStack.add(deserializerMiddleware(config, deserializer), deserializerMiddlewareOption);
            commandStack.add(serializerMiddleware(config, serializer), serializerMiddlewareOption);
        },
    };
}

({
    step: "serialize",
    tags: ["HTTP_AUTH_SCHEME"],
    name: "httpAuthSchemeMiddleware",
    override: true,
    relation: "before",
    toMiddleware: serializerMiddlewareOption.name,
});

const defaultErrorHandler$1 = (signingProperties) => (error) => {
    throw error;
};
const defaultSuccessHandler$1 = (httpResponse, signingProperties) => { };
const httpSigningMiddleware = (config) => (next, context) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
        return next(args);
    }
    const smithyContext = getSmithyContext(context);
    const scheme = smithyContext.selectedHttpAuthScheme;
    if (!scheme) {
        throw new Error(`No HttpAuthScheme was selected: unable to sign request`);
    }
    const { httpAuthOption: { signingProperties = {} }, identity, signer, } = scheme;
    const output = await next({
        ...args,
        request: await signer.sign(args.request, identity, signingProperties),
    }).catch((signer.errorHandler || defaultErrorHandler$1)(signingProperties));
    (signer.successHandler || defaultSuccessHandler$1)(output.response, signingProperties);
    return output;
};

const httpSigningMiddlewareOptions = {
    step: "finalizeRequest",
    tags: ["HTTP_SIGNING"],
    name: "httpSigningMiddleware",
    aliases: ["apiKeyMiddleware", "tokenMiddleware", "awsAuthMiddleware"],
    override: true,
    relation: "after",
    toMiddleware: "retryMiddleware",
};
const getHttpSigningPlugin = (config) => ({
    applyToStack: (clientStack) => {
        clientStack.addRelativeTo(httpSigningMiddleware(), httpSigningMiddlewareOptions);
    },
});

const normalizeProvider = (input) => {
    if (typeof input === "function")
        return input;
    const promisified = Promise.resolve(input);
    return () => promisified;
};

const isArrayBuffer = (arg) => (typeof ArrayBuffer === "function" && arg instanceof ArrayBuffer) ||
    Object.prototype.toString.call(arg) === "[object ArrayBuffer]";

const fromArrayBuffer = (input, offset = 0, length = input.byteLength - offset) => {
    if (!isArrayBuffer(input)) {
        throw new TypeError(`The "input" argument must be ArrayBuffer. Received type ${typeof input} (${input})`);
    }
    return Buffer$1.from(input, offset, length);
};
const fromString$1 = (input, encoding) => {
    if (typeof input !== "string") {
        throw new TypeError(`The "input" argument must be of type string. Received type ${typeof input} (${input})`);
    }
    return encoding ? Buffer$1.from(input, encoding) : Buffer$1.from(input);
};

const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;
const fromBase64 = (input) => {
    if ((input.length * 3) % 4 !== 0) {
        throw new TypeError(`Incorrect padding on base64 string.`);
    }
    if (!BASE64_REGEX.exec(input)) {
        throw new TypeError(`Invalid base64 string.`);
    }
    const buffer = fromString$1(input, "base64");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};

const fromUtf8$2 = (input) => {
    const buf = fromString$1(input, "utf8");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint8Array.BYTES_PER_ELEMENT);
};

const toUint8Array = (data) => {
    if (typeof data === "string") {
        return fromUtf8$2(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
    }
    return new Uint8Array(data);
};

const toUtf8 = (input) => {
    if (typeof input === "string") {
        return input;
    }
    if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") {
        throw new Error("@smithy/util-utf8: toUtf8 encoder function only accepts string | Uint8Array.");
    }
    return fromArrayBuffer(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
};

const toBase64 = (_input) => {
    let input;
    if (typeof _input === "string") {
        input = fromUtf8$2(_input);
    }
    else {
        input = _input;
    }
    if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") {
        throw new Error("@smithy/util-base64: toBase64 encoder function only accepts string | Uint8Array.");
    }
    return fromArrayBuffer(input.buffer, input.byteOffset, input.byteLength).toString("base64");
};

function transformToString(payload, encoding = "utf-8") {
    if (encoding === "base64") {
        return toBase64(payload);
    }
    return toUtf8(payload);
}
function transformFromString(str, encoding) {
    if (encoding === "base64") {
        return Uint8ArrayBlobAdapter.mutate(fromBase64(str));
    }
    return Uint8ArrayBlobAdapter.mutate(fromUtf8$2(str));
}

class Uint8ArrayBlobAdapter extends Uint8Array {
    static fromString(source, encoding = "utf-8") {
        switch (typeof source) {
            case "string":
                return transformFromString(source, encoding);
            default:
                throw new Error(`Unsupported conversion from ${typeof source} to Uint8ArrayBlobAdapter.`);
        }
    }
    static mutate(source) {
        Object.setPrototypeOf(source, Uint8ArrayBlobAdapter.prototype);
        return source;
    }
    transformToString(encoding = "utf-8") {
        return transformToString(this, encoding);
    }
}

const getAwsChunkedEncodingStream = (readableStream, options) => {
    const { base64Encoder, bodyLengthChecker, checksumAlgorithmFn, checksumLocationName, streamHasher } = options;
    const checksumRequired = base64Encoder !== undefined &&
        checksumAlgorithmFn !== undefined &&
        checksumLocationName !== undefined &&
        streamHasher !== undefined;
    const digest = checksumRequired ? streamHasher(checksumAlgorithmFn, readableStream) : undefined;
    const awsChunkedEncodingStream = new Readable({ read: () => { } });
    readableStream.on("data", (data) => {
        const length = bodyLengthChecker(data) || 0;
        awsChunkedEncodingStream.push(`${length.toString(16)}\r\n`);
        awsChunkedEncodingStream.push(data);
        awsChunkedEncodingStream.push("\r\n");
    });
    readableStream.on("end", async () => {
        awsChunkedEncodingStream.push(`0\r\n`);
        if (checksumRequired) {
            const checksum = base64Encoder(await digest);
            awsChunkedEncodingStream.push(`${checksumLocationName}:${checksum}\r\n`);
            awsChunkedEncodingStream.push(`\r\n`);
        }
        awsChunkedEncodingStream.push(null);
    });
    return awsChunkedEncodingStream;
};

const escapeUri = (uri) => encodeURIComponent(uri).replace(/[!'()*]/g, hexEncode);
const hexEncode = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;

function buildQueryString(query) {
    const parts = [];
    for (let key of Object.keys(query).sort()) {
        const value = query[key];
        key = escapeUri(key);
        if (Array.isArray(value)) {
            for (let i = 0, iLen = value.length; i < iLen; i++) {
                parts.push(`${key}=${escapeUri(value[i])}`);
            }
        }
        else {
            let qsEntry = key;
            if (value || typeof value === "string") {
                qsEntry += `=${escapeUri(value)}`;
            }
            parts.push(qsEntry);
        }
    }
    return parts.join("&");
}

const NODEJS_TIMEOUT_ERROR_CODES$1 = ["ECONNRESET", "EPIPE", "ETIMEDOUT"];

const getTransformedHeaders = (headers) => {
    const transformedHeaders = {};
    for (const name of Object.keys(headers)) {
        const headerValues = headers[name];
        transformedHeaders[name] = Array.isArray(headerValues) ? headerValues.join(",") : headerValues;
    }
    return transformedHeaders;
};

const timing = {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (timeoutId) => clearTimeout(timeoutId),
};

const DEFER_EVENT_LISTENER_TIME$2 = 1000;
const setConnectionTimeout = (request, reject, timeoutInMs = 0) => {
    if (!timeoutInMs) {
        return -1;
    }
    const registerTimeout = (offset) => {
        const timeoutId = timing.setTimeout(() => {
            request.destroy();
            reject(Object.assign(new Error(`Socket timed out without establishing a connection within ${timeoutInMs} ms`), {
                name: "TimeoutError",
            }));
        }, timeoutInMs - offset);
        const doWithSocket = (socket) => {
            if (socket?.connecting) {
                socket.on("connect", () => {
                    timing.clearTimeout(timeoutId);
                });
            }
            else {
                timing.clearTimeout(timeoutId);
            }
        };
        if (request.socket) {
            doWithSocket(request.socket);
        }
        else {
            request.on("socket", doWithSocket);
        }
    };
    if (timeoutInMs < 2000) {
        registerTimeout(0);
        return 0;
    }
    return timing.setTimeout(registerTimeout.bind(null, DEFER_EVENT_LISTENER_TIME$2), DEFER_EVENT_LISTENER_TIME$2);
};

const DEFER_EVENT_LISTENER_TIME$1 = 3000;
const setSocketKeepAlive = (request, { keepAlive, keepAliveMsecs }, deferTimeMs = DEFER_EVENT_LISTENER_TIME$1) => {
    if (keepAlive !== true) {
        return -1;
    }
    const registerListener = () => {
        if (request.socket) {
            request.socket.setKeepAlive(keepAlive, keepAliveMsecs || 0);
        }
        else {
            request.on("socket", (socket) => {
                socket.setKeepAlive(keepAlive, keepAliveMsecs || 0);
            });
        }
    };
    if (deferTimeMs === 0) {
        registerListener();
        return 0;
    }
    return timing.setTimeout(registerListener, deferTimeMs);
};

const DEFER_EVENT_LISTENER_TIME = 3000;
const setSocketTimeout = (request, reject, timeoutInMs = DEFAULT_REQUEST_TIMEOUT) => {
    const registerTimeout = (offset) => {
        const timeout = timeoutInMs - offset;
        const onTimeout = () => {
            request.destroy();
            reject(Object.assign(new Error(`Connection timed out after ${timeoutInMs} ms`), { name: "TimeoutError" }));
        };
        if (request.socket) {
            request.socket.setTimeout(timeout, onTimeout);
        }
        else {
            request.setTimeout(timeout, onTimeout);
        }
    };
    if (0 < timeoutInMs && timeoutInMs < 6000) {
        registerTimeout(0);
        return 0;
    }
    return timing.setTimeout(registerTimeout.bind(null, timeoutInMs === 0 ? 0 : DEFER_EVENT_LISTENER_TIME), DEFER_EVENT_LISTENER_TIME);
};

const MIN_WAIT_TIME = 6000;
async function writeRequestBody(httpRequest, request, maxContinueTimeoutMs = MIN_WAIT_TIME) {
    const headers = request.headers ?? {};
    const expect = headers["Expect"] || headers["expect"];
    let timeoutId = -1;
    let sendBody = true;
    if (expect === "100-continue") {
        sendBody = await Promise.race([
            new Promise((resolve) => {
                timeoutId = Number(timing.setTimeout(() => resolve(true), Math.max(MIN_WAIT_TIME, maxContinueTimeoutMs)));
            }),
            new Promise((resolve) => {
                httpRequest.on("continue", () => {
                    timing.clearTimeout(timeoutId);
                    resolve(true);
                });
                httpRequest.on("response", () => {
                    timing.clearTimeout(timeoutId);
                    resolve(false);
                });
                httpRequest.on("error", () => {
                    timing.clearTimeout(timeoutId);
                    resolve(false);
                });
            }),
        ]);
    }
    if (sendBody) {
        writeBody(httpRequest, request.body);
    }
}
function writeBody(httpRequest, body) {
    if (body instanceof Readable) {
        body.pipe(httpRequest);
        return;
    }
    if (body) {
        if (Buffer.isBuffer(body) || typeof body === "string") {
            httpRequest.end(body);
            return;
        }
        const uint8 = body;
        if (typeof uint8 === "object" &&
            uint8.buffer &&
            typeof uint8.byteOffset === "number" &&
            typeof uint8.byteLength === "number") {
            httpRequest.end(Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength));
            return;
        }
        httpRequest.end(Buffer.from(body));
        return;
    }
    httpRequest.end();
}

const DEFAULT_REQUEST_TIMEOUT = 0;
class NodeHttpHandler {
    static create(instanceOrOptions) {
        if (typeof instanceOrOptions?.handle === "function") {
            return instanceOrOptions;
        }
        return new NodeHttpHandler(instanceOrOptions);
    }
    static checkSocketUsage(agent, socketWarningTimestamp, logger = console) {
        const { sockets, requests, maxSockets } = agent;
        if (typeof maxSockets !== "number" || maxSockets === Infinity) {
            return socketWarningTimestamp;
        }
        const interval = 15000;
        if (Date.now() - interval < socketWarningTimestamp) {
            return socketWarningTimestamp;
        }
        if (sockets && requests) {
            for (const origin in sockets) {
                const socketsInUse = sockets[origin]?.length ?? 0;
                const requestsEnqueued = requests[origin]?.length ?? 0;
                if (socketsInUse >= maxSockets && requestsEnqueued >= 2 * maxSockets) {
                    logger?.warn?.(`@smithy/node-http-handler:WARN - socket usage at capacity=${socketsInUse} and ${requestsEnqueued} additional requests are enqueued.
See https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html
or increase socketAcquisitionWarningTimeout=(millis) in the NodeHttpHandler config.`);
                    return Date.now();
                }
            }
        }
        return socketWarningTimestamp;
    }
    constructor(options) {
        this.socketWarningTimestamp = 0;
        this.metadata = { handlerProtocol: "http/1.1" };
        this.configProvider = new Promise((resolve, reject) => {
            if (typeof options === "function") {
                options()
                    .then((_options) => {
                    resolve(this.resolveDefaultConfig(_options));
                })
                    .catch(reject);
            }
            else {
                resolve(this.resolveDefaultConfig(options));
            }
        });
    }
    resolveDefaultConfig(options) {
        const { requestTimeout, connectionTimeout, socketTimeout, httpAgent, httpsAgent } = options || {};
        const keepAlive = true;
        const maxSockets = 50;
        return {
            connectionTimeout,
            requestTimeout: requestTimeout ?? socketTimeout,
            httpAgent: (() => {
                if (httpAgent instanceof Agent || typeof httpAgent?.destroy === "function") {
                    return httpAgent;
                }
                return new Agent({ keepAlive, maxSockets, ...httpAgent });
            })(),
            httpsAgent: (() => {
                if (httpsAgent instanceof Agent$1 || typeof httpsAgent?.destroy === "function") {
                    return httpsAgent;
                }
                return new Agent$1({ keepAlive, maxSockets, ...httpsAgent });
            })(),
            logger: console,
        };
    }
    destroy() {
        this.config?.httpAgent?.destroy();
        this.config?.httpsAgent?.destroy();
    }
    async handle(request$2, { abortSignal } = {}) {
        if (!this.config) {
            this.config = await this.configProvider;
        }
        return new Promise((_resolve, _reject) => {
            let writeRequestBodyPromise = undefined;
            const timeouts = [];
            const resolve = async (arg) => {
                await writeRequestBodyPromise;
                timeouts.forEach(timing.clearTimeout);
                _resolve(arg);
            };
            const reject = async (arg) => {
                await writeRequestBodyPromise;
                timeouts.forEach(timing.clearTimeout);
                _reject(arg);
            };
            if (!this.config) {
                throw new Error("Node HTTP request handler config is not resolved");
            }
            if (abortSignal?.aborted) {
                const abortError = new Error("Request aborted");
                abortError.name = "AbortError";
                reject(abortError);
                return;
            }
            const isSSL = request$2.protocol === "https:";
            const agent = isSSL ? this.config.httpsAgent : this.config.httpAgent;
            timeouts.push(timing.setTimeout(() => {
                this.socketWarningTimestamp = NodeHttpHandler.checkSocketUsage(agent, this.socketWarningTimestamp, this.config.logger);
            }, this.config.socketAcquisitionWarningTimeout ??
                (this.config.requestTimeout ?? 2000) + (this.config.connectionTimeout ?? 1000)));
            const queryString = buildQueryString(request$2.query || {});
            let auth = undefined;
            if (request$2.username != null || request$2.password != null) {
                const username = request$2.username ?? "";
                const password = request$2.password ?? "";
                auth = `${username}:${password}`;
            }
            let path = request$2.path;
            if (queryString) {
                path += `?${queryString}`;
            }
            if (request$2.fragment) {
                path += `#${request$2.fragment}`;
            }
            let hostname = request$2.hostname ?? "";
            if (hostname[0] === "[" && hostname.endsWith("]")) {
                hostname = request$2.hostname.slice(1, -1);
            }
            else {
                hostname = request$2.hostname;
            }
            const nodeHttpsOptions = {
                headers: request$2.headers,
                host: hostname,
                method: request$2.method,
                path,
                port: request$2.port,
                agent,
                auth,
            };
            const requestFunc = isSSL ? request : request$1;
            const req = requestFunc(nodeHttpsOptions, (res) => {
                const httpResponse = new HttpResponse({
                    statusCode: res.statusCode || -1,
                    reason: res.statusMessage,
                    headers: getTransformedHeaders(res.headers),
                    body: res,
                });
                resolve({ response: httpResponse });
            });
            req.on("error", (err) => {
                if (NODEJS_TIMEOUT_ERROR_CODES$1.includes(err.code)) {
                    reject(Object.assign(err, { name: "TimeoutError" }));
                }
                else {
                    reject(err);
                }
            });
            if (abortSignal) {
                const onAbort = () => {
                    req.destroy();
                    const abortError = new Error("Request aborted");
                    abortError.name = "AbortError";
                    reject(abortError);
                };
                if (typeof abortSignal.addEventListener === "function") {
                    const signal = abortSignal;
                    signal.addEventListener("abort", onAbort, { once: true });
                    req.once("close", () => signal.removeEventListener("abort", onAbort));
                }
                else {
                    abortSignal.onabort = onAbort;
                }
            }
            timeouts.push(setConnectionTimeout(req, reject, this.config.connectionTimeout));
            timeouts.push(setSocketTimeout(req, reject, this.config.requestTimeout));
            const httpAgent = nodeHttpsOptions.agent;
            if (typeof httpAgent === "object" && "keepAlive" in httpAgent) {
                timeouts.push(setSocketKeepAlive(req, {
                    keepAlive: httpAgent.keepAlive,
                    keepAliveMsecs: httpAgent.keepAliveMsecs,
                }));
            }
            writeRequestBodyPromise = writeRequestBody(req, request$2, this.config.requestTimeout).catch((e) => {
                timeouts.forEach(timing.clearTimeout);
                return _reject(e);
            });
        });
    }
    updateHttpClientConfig(key, value) {
        this.config = undefined;
        this.configProvider = this.configProvider.then((config) => {
            return {
                ...config,
                [key]: value,
            };
        });
    }
    httpHandlerConfigs() {
        return this.config ?? {};
    }
}

class Collector$1 extends Writable {
    constructor() {
        super(...arguments);
        this.bufferedBytes = [];
    }
    _write(chunk, encoding, callback) {
        this.bufferedBytes.push(chunk);
        callback();
    }
}

const streamCollector$1 = (stream) => {
    if (isReadableStreamInstance(stream)) {
        return collectReadableStream(stream);
    }
    return new Promise((resolve, reject) => {
        const collector = new Collector$1();
        stream.pipe(collector);
        stream.on("error", (err) => {
            collector.end();
            reject(err);
        });
        collector.on("error", reject);
        collector.on("finish", function () {
            const bytes = new Uint8Array(Buffer.concat(this.bufferedBytes));
            resolve(bytes);
        });
    });
};
const isReadableStreamInstance = (stream) => typeof ReadableStream === "function" && stream instanceof ReadableStream;
async function collectReadableStream(stream) {
    const chunks = [];
    const reader = stream.getReader();
    let isDone = false;
    let length = 0;
    while (!isDone) {
        const { done, value } = await reader.read();
        if (value) {
            chunks.push(value);
            length += value.length;
        }
        isDone = done;
    }
    const collected = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        collected.set(chunk, offset);
        offset += chunk.length;
    }
    return collected;
}

const streamCollector = async (stream) => {
    if ((typeof Blob === "function" && stream instanceof Blob) || stream.constructor?.name === "Blob") {
        if (Blob.prototype.arrayBuffer !== undefined) {
            return new Uint8Array(await stream.arrayBuffer());
        }
        return collectBlob(stream);
    }
    return collectStream(stream);
};
async function collectBlob(blob) {
    const base64 = await readToBase64(blob);
    const arrayBuffer = fromBase64(base64);
    return new Uint8Array(arrayBuffer);
}
async function collectStream(stream) {
    const chunks = [];
    const reader = stream.getReader();
    let isDone = false;
    let length = 0;
    while (!isDone) {
        const { done, value } = await reader.read();
        if (value) {
            chunks.push(value);
            length += value.length;
        }
        isDone = done;
    }
    const collected = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        collected.set(chunk, offset);
        offset += chunk.length;
    }
    return collected;
}
function readToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (reader.readyState !== 2) {
                return reject(new Error("Reader aborted too early"));
            }
            const result = (reader.result ?? "");
            const commaIndex = result.indexOf(",");
            const dataOffset = commaIndex > -1 ? commaIndex + 1 : result.length;
            resolve(result.substring(dataOffset));
        };
        reader.onabort = () => reject(new Error("Read aborted"));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

const SHORT_TO_HEX = {};
const HEX_TO_SHORT = {};
for (let i = 0; i < 256; i++) {
    let encodedByte = i.toString(16).toLowerCase();
    if (encodedByte.length === 1) {
        encodedByte = `0${encodedByte}`;
    }
    SHORT_TO_HEX[i] = encodedByte;
    HEX_TO_SHORT[encodedByte] = i;
}
function fromHex(encoded) {
    if (encoded.length % 2 !== 0) {
        throw new Error("Hex encoded strings must have an even number length");
    }
    const out = new Uint8Array(encoded.length / 2);
    for (let i = 0; i < encoded.length; i += 2) {
        const encodedByte = encoded.slice(i, i + 2).toLowerCase();
        if (encodedByte in HEX_TO_SHORT) {
            out[i / 2] = HEX_TO_SHORT[encodedByte];
        }
        else {
            throw new Error(`Cannot decode unrecognized sequence ${encodedByte} as hexadecimal`);
        }
    }
    return out;
}
function toHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        out += SHORT_TO_HEX[bytes[i]];
    }
    return out;
}

const isReadableStream = (stream) => typeof ReadableStream === "function" &&
    (stream?.constructor?.name === ReadableStream.name || stream instanceof ReadableStream);
const isBlob = (blob) => {
    return typeof Blob === "function" && (blob?.constructor?.name === Blob.name || blob instanceof Blob);
};

const ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1 = "The stream has already been transformed.";
const sdkStreamMixin$1 = (stream) => {
    if (!isBlobInstance(stream) && !isReadableStream(stream)) {
        const name = stream?.__proto__?.constructor?.name || stream;
        throw new Error(`Unexpected stream implementation, expect Blob or ReadableStream, got ${name}`);
    }
    let transformed = false;
    const transformToByteArray = async () => {
        if (transformed) {
            throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1);
        }
        transformed = true;
        return await streamCollector(stream);
    };
    const blobToWebStream = (blob) => {
        if (typeof blob.stream !== "function") {
            throw new Error("Cannot transform payload Blob to web stream. Please make sure the Blob.stream() is polyfilled.\n" +
                "If you are using React Native, this API is not yet supported, see: https://react-native.canny.io/feature-requests/p/fetch-streaming-body");
        }
        return blob.stream();
    };
    return Object.assign(stream, {
        transformToByteArray: transformToByteArray,
        transformToString: async (encoding) => {
            const buf = await transformToByteArray();
            if (encoding === "base64") {
                return toBase64(buf);
            }
            else if (encoding === "hex") {
                return toHex(buf);
            }
            else if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") {
                return toUtf8(buf);
            }
            else if (typeof TextDecoder === "function") {
                return new TextDecoder(encoding).decode(buf);
            }
            else {
                throw new Error("TextDecoder is not available, please make sure polyfill is provided.");
            }
        },
        transformToWebStream: () => {
            if (transformed) {
                throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED$1);
            }
            transformed = true;
            if (isBlobInstance(stream)) {
                return blobToWebStream(stream);
            }
            else if (isReadableStream(stream)) {
                return stream;
            }
            else {
                throw new Error(`Cannot transform payload to web stream, got ${stream}`);
            }
        },
    });
};
const isBlobInstance = (stream) => typeof Blob === "function" && stream instanceof Blob;

const ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED = "The stream has already been transformed.";
const sdkStreamMixin = (stream) => {
    if (!(stream instanceof Readable)) {
        try {
            return sdkStreamMixin$1(stream);
        }
        catch (e) {
            const name = stream?.__proto__?.constructor?.name || stream;
            throw new Error(`Unexpected stream implementation, expect Stream.Readable instance, got ${name}`);
        }
    }
    let transformed = false;
    const transformToByteArray = async () => {
        if (transformed) {
            throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED);
        }
        transformed = true;
        return await streamCollector$1(stream);
    };
    return Object.assign(stream, {
        transformToByteArray,
        transformToString: async (encoding) => {
            const buf = await transformToByteArray();
            if (encoding === undefined || Buffer.isEncoding(encoding)) {
                return fromArrayBuffer(buf.buffer, buf.byteOffset, buf.byteLength).toString(encoding);
            }
            else {
                const decoder = new TextDecoder(encoding);
                return decoder.decode(buf);
            }
        },
        transformToWebStream: () => {
            if (transformed) {
                throw new Error(ERR_MSG_STREAM_HAS_BEEN_TRANSFORMED);
            }
            if (stream.readableFlowing !== null) {
                throw new Error("The stream has been consumed by other callbacks.");
            }
            if (typeof Readable.toWeb !== "function") {
                throw new Error("Readable.toWeb() is not supported. Please ensure a polyfill is available.");
            }
            transformed = true;
            return Readable.toWeb(stream);
        },
    });
};

async function splitStream$1(stream) {
    if (typeof stream.stream === "function") {
        stream = stream.stream();
    }
    const readableStream = stream;
    return readableStream.tee();
}

async function splitStream(stream) {
    if (isReadableStream(stream) || isBlob(stream)) {
        return splitStream$1(stream);
    }
    const stream1 = new PassThrough();
    const stream2 = new PassThrough();
    stream.pipe(stream1);
    stream.pipe(stream2);
    return [stream1, stream2];
}

async function headStream$1(stream, bytes) {
    let byteLengthCounter = 0;
    const chunks = [];
    const reader = stream.getReader();
    let isDone = false;
    while (!isDone) {
        const { done, value } = await reader.read();
        if (value) {
            chunks.push(value);
            byteLengthCounter += value?.byteLength ?? 0;
        }
        if (byteLengthCounter >= bytes) {
            break;
        }
        isDone = done;
    }
    reader.releaseLock();
    const collected = new Uint8Array(Math.min(bytes, byteLengthCounter));
    let offset = 0;
    for (const chunk of chunks) {
        if (chunk.byteLength > collected.byteLength - offset) {
            collected.set(chunk.subarray(0, collected.byteLength - offset), offset);
            break;
        }
        else {
            collected.set(chunk, offset);
        }
        offset += chunk.length;
    }
    return collected;
}

const headStream = (stream, bytes) => {
    if (isReadableStream(stream)) {
        return headStream$1(stream, bytes);
    }
    return new Promise((resolve, reject) => {
        const collector = new Collector();
        collector.limit = bytes;
        stream.pipe(collector);
        stream.on("error", (err) => {
            collector.end();
            reject(err);
        });
        collector.on("error", reject);
        collector.on("finish", function () {
            const bytes = new Uint8Array(Buffer.concat(this.buffers));
            resolve(bytes);
        });
    });
};
class Collector extends Writable {
    constructor() {
        super(...arguments);
        this.buffers = [];
        this.limit = Infinity;
        this.bytesBuffered = 0;
    }
    _write(chunk, encoding, callback) {
        this.buffers.push(chunk);
        this.bytesBuffered += chunk.byteLength ?? 0;
        if (this.bytesBuffered >= this.limit) {
            const excess = this.bytesBuffered - this.limit;
            const tailBuffer = this.buffers[this.buffers.length - 1];
            this.buffers[this.buffers.length - 1] = tailBuffer.subarray(0, tailBuffer.byteLength - excess);
            this.emit("finish");
        }
        callback();
    }
}

class ChecksumStream$1 extends Duplex {
    constructor({ expectedChecksum, checksum, source, checksumSourceLocation, base64Encoder, }) {
        super();
        if (typeof source.pipe === "function") {
            this.source = source;
        }
        else {
            throw new Error(`@smithy/util-stream: unsupported source type ${source?.constructor?.name ?? source} in ChecksumStream.`);
        }
        this.base64Encoder = base64Encoder ?? toBase64;
        this.expectedChecksum = expectedChecksum;
        this.checksum = checksum;
        this.checksumSourceLocation = checksumSourceLocation;
        this.source.pipe(this);
    }
    _read(size) { }
    _write(chunk, encoding, callback) {
        try {
            this.checksum.update(chunk);
            this.push(chunk);
        }
        catch (e) {
            return callback(e);
        }
        return callback();
    }
    async _final(callback) {
        try {
            const digest = await this.checksum.digest();
            const received = this.base64Encoder(digest);
            if (this.expectedChecksum !== received) {
                return callback(new Error(`Checksum mismatch: expected "${this.expectedChecksum}" but received "${received}"` +
                    ` in response header "${this.checksumSourceLocation}".`));
            }
        }
        catch (e) {
            return callback(e);
        }
        this.push(null);
        return callback();
    }
}

const ReadableStreamRef = typeof ReadableStream === "function" ? ReadableStream : function () { };
class ChecksumStream extends ReadableStreamRef {
}

const createChecksumStream$1 = ({ expectedChecksum, checksum, source, checksumSourceLocation, base64Encoder, }) => {
    if (!isReadableStream(source)) {
        throw new Error(`@smithy/util-stream: unsupported source type ${source?.constructor?.name ?? source} in ChecksumStream.`);
    }
    const encoder = base64Encoder ?? toBase64;
    if (typeof TransformStream !== "function") {
        throw new Error("@smithy/util-stream: unable to instantiate ChecksumStream because API unavailable: ReadableStream/TransformStream.");
    }
    const transform = new TransformStream({
        start() { },
        async transform(chunk, controller) {
            checksum.update(chunk);
            controller.enqueue(chunk);
        },
        async flush(controller) {
            const digest = await checksum.digest();
            const received = encoder(digest);
            if (expectedChecksum !== received) {
                const error = new Error(`Checksum mismatch: expected "${expectedChecksum}" but received "${received}"` +
                    ` in response header "${checksumSourceLocation}".`);
                controller.error(error);
            }
            else {
                controller.terminate();
            }
        },
    });
    source.pipeThrough(transform);
    const readable = transform.readable;
    Object.setPrototypeOf(readable, ChecksumStream.prototype);
    return readable;
};

function createChecksumStream(init) {
    if (typeof ReadableStream === "function" && isReadableStream(init.source)) {
        return createChecksumStream$1(init);
    }
    return new ChecksumStream$1(init);
}

const collectBody$1 = async (streamBody = new Uint8Array(), context) => {
    if (streamBody instanceof Uint8Array) {
        return Uint8ArrayBlobAdapter.mutate(streamBody);
    }
    if (!streamBody) {
        return Uint8ArrayBlobAdapter.mutate(new Uint8Array());
    }
    const fromContext = context.streamCollector(streamBody);
    return Uint8ArrayBlobAdapter.mutate(await fromContext);
};

function extendedEncodeURIComponent(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, function (c) {
        return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

const resolvedPath = (resolvedPath, input, memberName, labelValueProvider, uriLabel, isGreedyLabel) => {
    if (input != null && input[memberName] !== undefined) {
        const labelValue = labelValueProvider();
        if (labelValue.length <= 0) {
            throw new Error("Empty value provided for input HTTP label: " + memberName + ".");
        }
        resolvedPath = resolvedPath.replace(uriLabel, isGreedyLabel
            ? labelValue
                .split("/")
                .map((segment) => extendedEncodeURIComponent(segment))
                .join("/")
            : extendedEncodeURIComponent(labelValue));
    }
    else {
        throw new Error("No value provided for input HTTP label: " + memberName + ".");
    }
    return resolvedPath;
};

function requestBuilder(input, context) {
    return new RequestBuilder(input, context);
}
class RequestBuilder {
    constructor(input, context) {
        this.input = input;
        this.context = context;
        this.query = {};
        this.method = "";
        this.headers = {};
        this.path = "";
        this.body = null;
        this.hostname = "";
        this.resolvePathStack = [];
    }
    async build() {
        const { hostname, protocol = "https", port, path: basePath } = await this.context.endpoint();
        this.path = basePath;
        for (const resolvePath of this.resolvePathStack) {
            resolvePath(this.path);
        }
        return new HttpRequest({
            protocol,
            hostname: this.hostname || hostname,
            port,
            method: this.method,
            path: this.path,
            query: this.query,
            body: this.body,
            headers: this.headers,
        });
    }
    hn(hostname) {
        this.hostname = hostname;
        return this;
    }
    bp(uriLabel) {
        this.resolvePathStack.push((basePath) => {
            this.path = `${basePath?.endsWith("/") ? basePath.slice(0, -1) : basePath || ""}` + uriLabel;
        });
        return this;
    }
    p(memberName, labelValueProvider, uriLabel, isGreedyLabel) {
        this.resolvePathStack.push((path) => {
            this.path = resolvedPath(path, this.input, memberName, labelValueProvider, uriLabel, isGreedyLabel);
        });
        return this;
    }
    h(headers) {
        this.headers = headers;
        return this;
    }
    q(query) {
        this.query = query;
        return this;
    }
    b(body) {
        this.body = body;
        return this;
    }
    m(method) {
        this.method = method;
        return this;
    }
}

function setFeature(context, feature, value) {
    if (!context.__smithy_context) {
        context.__smithy_context = {
            features: {},
        };
    }
    else if (!context.__smithy_context.features) {
        context.__smithy_context.features = {};
    }
    context.__smithy_context.features[feature] = value;
}

class DefaultIdentityProviderConfig {
    constructor(config) {
        this.authSchemes = new Map();
        for (const [key, value] of Object.entries(config)) {
            if (value !== undefined) {
                this.authSchemes.set(key, value);
            }
        }
    }
    getIdentityProvider(schemeId) {
        return this.authSchemes.get(schemeId);
    }
}

class NoAuthSigner {
    async sign(httpRequest, identity, signingProperties) {
        return httpRequest;
    }
}

const createIsIdentityExpiredFunction = (expirationMs) => (identity) => doesIdentityRequireRefresh(identity) && identity.expiration.getTime() - Date.now() < expirationMs;
const EXPIRATION_MS = 300000;
const isIdentityExpired = createIsIdentityExpiredFunction(EXPIRATION_MS);
const doesIdentityRequireRefresh = (identity) => identity.expiration !== undefined;
const memoizeIdentityProvider = (provider, isExpired, requiresRefresh) => {
    if (provider === undefined) {
        return undefined;
    }
    const normalizedProvider = typeof provider !== "function" ? async () => Promise.resolve(provider) : provider;
    let resolved;
    let pending;
    let hasResult;
    let isConstant = false;
    const coalesceProvider = async (options) => {
        if (!pending) {
            pending = normalizedProvider(options);
        }
        try {
            resolved = await pending;
            hasResult = true;
            isConstant = false;
        }
        finally {
            pending = undefined;
        }
        return resolved;
    };
    if (isExpired === undefined) {
        return async (options) => {
            if (!hasResult || options?.forceRefresh) {
                resolved = await coalesceProvider(options);
            }
            return resolved;
        };
    }
    return async (options) => {
        if (!hasResult || options?.forceRefresh) {
            resolved = await coalesceProvider(options);
        }
        if (isConstant) {
            return resolved;
        }
        if (!requiresRefresh(resolved)) {
            isConstant = true;
            return resolved;
        }
        if (isExpired(resolved)) {
            await coalesceProvider(options);
            return resolved;
        }
        return resolved;
    };
};

class ProviderError extends Error {
    constructor(message, options = true) {
        let logger;
        let tryNextLink = true;
        if (typeof options === "boolean") {
            logger = undefined;
            tryNextLink = options;
        }
        else if (options != null && typeof options === "object") {
            logger = options.logger;
            tryNextLink = options.tryNextLink ?? true;
        }
        super(message);
        this.name = "ProviderError";
        this.tryNextLink = tryNextLink;
        Object.setPrototypeOf(this, ProviderError.prototype);
        logger?.debug?.(`@smithy/property-provider ${tryNextLink ? "->" : "(!)"} ${message}`);
    }
    static from(error, options = true) {
        return Object.assign(new this(error.message, options), error);
    }
}

class CredentialsProviderError extends ProviderError {
    constructor(message, options = true) {
        super(message, options);
        this.name = "CredentialsProviderError";
        Object.setPrototypeOf(this, CredentialsProviderError.prototype);
    }
}

class TokenProviderError extends ProviderError {
    constructor(message, options = true) {
        super(message, options);
        this.name = "TokenProviderError";
        Object.setPrototypeOf(this, TokenProviderError.prototype);
    }
}

const chain = (...providers) => async () => {
    if (providers.length === 0) {
        throw new ProviderError("No providers in chain");
    }
    let lastProviderError;
    for (const provider of providers) {
        try {
            const credentials = await provider();
            return credentials;
        }
        catch (err) {
            lastProviderError = err;
            if (err?.tryNextLink) {
                continue;
            }
            throw err;
        }
    }
    throw lastProviderError;
};

const fromStatic$1 = (staticValue) => () => Promise.resolve(staticValue);

const memoize = (provider, isExpired, requiresRefresh) => {
    let resolved;
    let pending;
    let hasResult;
    let isConstant = false;
    const coalesceProvider = async () => {
        if (!pending) {
            pending = provider();
        }
        try {
            resolved = await pending;
            hasResult = true;
            isConstant = false;
        }
        finally {
            pending = undefined;
        }
        return resolved;
    };
    if (isExpired === undefined) {
        return async (options) => {
            if (!hasResult || options?.forceRefresh) {
                resolved = await coalesceProvider();
            }
            return resolved;
        };
    }
    return async (options) => {
        if (!hasResult || options?.forceRefresh) {
            resolved = await coalesceProvider();
        }
        if (isConstant) {
            return resolved;
        }
        if (requiresRefresh && !requiresRefresh(resolved)) {
            isConstant = true;
            return resolved;
        }
        if (isExpired(resolved)) {
            await coalesceProvider();
            return resolved;
        }
        return resolved;
    };
};

const resolveAwsSdkSigV4AConfig = (config) => {
    config.sigv4aSigningRegionSet = normalizeProvider(config.sigv4aSigningRegionSet);
    return config;
};
const NODE_SIGV4A_CONFIG_OPTIONS = {
    environmentVariableSelector(env) {
        if (env.AWS_SIGV4A_SIGNING_REGION_SET) {
            return env.AWS_SIGV4A_SIGNING_REGION_SET.split(",").map((_) => _.trim());
        }
        throw new ProviderError("AWS_SIGV4A_SIGNING_REGION_SET not set in env.", {
            tryNextLink: true,
        });
    },
    configFileSelector(profile) {
        if (profile.sigv4a_signing_region_set) {
            return (profile.sigv4a_signing_region_set ?? "").split(",").map((_) => _.trim());
        }
        throw new ProviderError("sigv4a_signing_region_set not set in profile.", {
            tryNextLink: true,
        });
    },
    default: undefined,
};

const ALGORITHM_QUERY_PARAM = "X-Amz-Algorithm";
const CREDENTIAL_QUERY_PARAM = "X-Amz-Credential";
const AMZ_DATE_QUERY_PARAM = "X-Amz-Date";
const SIGNED_HEADERS_QUERY_PARAM = "X-Amz-SignedHeaders";
const EXPIRES_QUERY_PARAM = "X-Amz-Expires";
const SIGNATURE_QUERY_PARAM = "X-Amz-Signature";
const TOKEN_QUERY_PARAM = "X-Amz-Security-Token";
const AUTH_HEADER = "authorization";
const AMZ_DATE_HEADER = AMZ_DATE_QUERY_PARAM.toLowerCase();
const DATE_HEADER = "date";
const GENERATED_HEADERS = [AUTH_HEADER, AMZ_DATE_HEADER, DATE_HEADER];
const SIGNATURE_HEADER = SIGNATURE_QUERY_PARAM.toLowerCase();
const SHA256_HEADER = "x-amz-content-sha256";
const TOKEN_HEADER = TOKEN_QUERY_PARAM.toLowerCase();
const ALWAYS_UNSIGNABLE_HEADERS = {
    authorization: true,
    "cache-control": true,
    connection: true,
    expect: true,
    from: true,
    "keep-alive": true,
    "max-forwards": true,
    pragma: true,
    referer: true,
    te: true,
    trailer: true,
    "transfer-encoding": true,
    upgrade: true,
    "user-agent": true,
    "x-amzn-trace-id": true,
};
const PROXY_HEADER_PATTERN = /^proxy-/;
const SEC_HEADER_PATTERN = /^sec-/;
const ALGORITHM_IDENTIFIER = "AWS4-HMAC-SHA256";
const EVENT_ALGORITHM_IDENTIFIER = "AWS4-HMAC-SHA256-PAYLOAD";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_CACHE_SIZE = 50;
const KEY_TYPE_IDENTIFIER = "aws4_request";
const MAX_PRESIGNED_TTL = 60 * 60 * 24 * 7;

const signingKeyCache = {};
const cacheQueue = [];
const createScope = (shortDate, region, service) => `${shortDate}/${region}/${service}/${KEY_TYPE_IDENTIFIER}`;
const getSigningKey = async (sha256Constructor, credentials, shortDate, region, service) => {
    const credsHash = await hmac(sha256Constructor, credentials.secretAccessKey, credentials.accessKeyId);
    const cacheKey = `${shortDate}:${region}:${service}:${toHex(credsHash)}:${credentials.sessionToken}`;
    if (cacheKey in signingKeyCache) {
        return signingKeyCache[cacheKey];
    }
    cacheQueue.push(cacheKey);
    while (cacheQueue.length > MAX_CACHE_SIZE) {
        delete signingKeyCache[cacheQueue.shift()];
    }
    let key = `AWS4${credentials.secretAccessKey}`;
    for (const signable of [shortDate, region, service, KEY_TYPE_IDENTIFIER]) {
        key = await hmac(sha256Constructor, key, signable);
    }
    return (signingKeyCache[cacheKey] = key);
};
const hmac = (ctor, secret, data) => {
    const hash = new ctor(secret);
    hash.update(toUint8Array(data));
    return hash.digest();
};

const getCanonicalHeaders = ({ headers }, unsignableHeaders, signableHeaders) => {
    const canonical = {};
    for (const headerName of Object.keys(headers).sort()) {
        if (headers[headerName] == undefined) {
            continue;
        }
        const canonicalHeaderName = headerName.toLowerCase();
        if (canonicalHeaderName in ALWAYS_UNSIGNABLE_HEADERS ||
            unsignableHeaders?.has(canonicalHeaderName) ||
            PROXY_HEADER_PATTERN.test(canonicalHeaderName) ||
            SEC_HEADER_PATTERN.test(canonicalHeaderName)) {
            if (!signableHeaders || (signableHeaders && !signableHeaders.has(canonicalHeaderName))) {
                continue;
            }
        }
        canonical[canonicalHeaderName] = headers[headerName].trim().replace(/\s+/g, " ");
    }
    return canonical;
};

const getCanonicalQuery = ({ query = {} }) => {
    const keys = [];
    const serialized = {};
    for (const key of Object.keys(query)) {
        if (key.toLowerCase() === SIGNATURE_HEADER) {
            continue;
        }
        const encodedKey = escapeUri(key);
        keys.push(encodedKey);
        const value = query[key];
        if (typeof value === "string") {
            serialized[encodedKey] = `${encodedKey}=${escapeUri(value)}`;
        }
        else if (Array.isArray(value)) {
            serialized[encodedKey] = value
                .slice(0)
                .reduce((encoded, value) => encoded.concat([`${encodedKey}=${escapeUri(value)}`]), [])
                .sort()
                .join("&");
        }
    }
    return keys
        .sort()
        .map((key) => serialized[key])
        .filter((serialized) => serialized)
        .join("&");
};

const getPayloadHash = async ({ headers, body }, hashConstructor) => {
    for (const headerName of Object.keys(headers)) {
        if (headerName.toLowerCase() === SHA256_HEADER) {
            return headers[headerName];
        }
    }
    if (body == undefined) {
        return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    }
    else if (typeof body === "string" || ArrayBuffer.isView(body) || isArrayBuffer(body)) {
        const hashCtor = new hashConstructor();
        hashCtor.update(toUint8Array(body));
        return toHex(await hashCtor.digest());
    }
    return UNSIGNED_PAYLOAD;
};

class HeaderFormatter {
    format(headers) {
        const chunks = [];
        for (const headerName of Object.keys(headers)) {
            const bytes = fromUtf8$2(headerName);
            chunks.push(Uint8Array.from([bytes.byteLength]), bytes, this.formatHeaderValue(headers[headerName]));
        }
        const out = new Uint8Array(chunks.reduce((carry, bytes) => carry + bytes.byteLength, 0));
        let position = 0;
        for (const chunk of chunks) {
            out.set(chunk, position);
            position += chunk.byteLength;
        }
        return out;
    }
    formatHeaderValue(header) {
        switch (header.type) {
            case "boolean":
                return Uint8Array.from([header.value ? 0 : 1]);
            case "byte":
                return Uint8Array.from([2, header.value]);
            case "short":
                const shortView = new DataView(new ArrayBuffer(3));
                shortView.setUint8(0, 3);
                shortView.setInt16(1, header.value, false);
                return new Uint8Array(shortView.buffer);
            case "integer":
                const intView = new DataView(new ArrayBuffer(5));
                intView.setUint8(0, 4);
                intView.setInt32(1, header.value, false);
                return new Uint8Array(intView.buffer);
            case "long":
                const longBytes = new Uint8Array(9);
                longBytes[0] = 5;
                longBytes.set(header.value.bytes, 1);
                return longBytes;
            case "binary":
                const binView = new DataView(new ArrayBuffer(3 + header.value.byteLength));
                binView.setUint8(0, 6);
                binView.setUint16(1, header.value.byteLength, false);
                const binBytes = new Uint8Array(binView.buffer);
                binBytes.set(header.value, 3);
                return binBytes;
            case "string":
                const utf8Bytes = fromUtf8$2(header.value);
                const strView = new DataView(new ArrayBuffer(3 + utf8Bytes.byteLength));
                strView.setUint8(0, 7);
                strView.setUint16(1, utf8Bytes.byteLength, false);
                const strBytes = new Uint8Array(strView.buffer);
                strBytes.set(utf8Bytes, 3);
                return strBytes;
            case "timestamp":
                const tsBytes = new Uint8Array(9);
                tsBytes[0] = 8;
                tsBytes.set(Int64$1.fromNumber(header.value.valueOf()).bytes, 1);
                return tsBytes;
            case "uuid":
                if (!UUID_PATTERN$1.test(header.value)) {
                    throw new Error(`Invalid UUID received: ${header.value}`);
                }
                const uuidBytes = new Uint8Array(17);
                uuidBytes[0] = 9;
                uuidBytes.set(fromHex(header.value.replace(/\-/g, "")), 1);
                return uuidBytes;
        }
    }
}
var HEADER_VALUE_TYPE$1;
(function (HEADER_VALUE_TYPE) {
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["boolTrue"] = 0] = "boolTrue";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["boolFalse"] = 1] = "boolFalse";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["byte"] = 2] = "byte";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["short"] = 3] = "short";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["integer"] = 4] = "integer";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["long"] = 5] = "long";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["byteArray"] = 6] = "byteArray";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["string"] = 7] = "string";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["timestamp"] = 8] = "timestamp";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["uuid"] = 9] = "uuid";
})(HEADER_VALUE_TYPE$1 || (HEADER_VALUE_TYPE$1 = {}));
const UUID_PATTERN$1 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
class Int64$1 {
    constructor(bytes) {
        this.bytes = bytes;
        if (bytes.byteLength !== 8) {
            throw new Error("Int64 buffers must be exactly 8 bytes");
        }
    }
    static fromNumber(number) {
        if (number > 9223372036854776000 || number < -9223372036854776000) {
            throw new Error(`${number} is too large (or, if negative, too small) to represent as an Int64`);
        }
        const bytes = new Uint8Array(8);
        for (let i = 7, remaining = Math.abs(Math.round(number)); i > -1 && remaining > 0; i--, remaining /= 256) {
            bytes[i] = remaining;
        }
        if (number < 0) {
            negate$1(bytes);
        }
        return new Int64$1(bytes);
    }
    valueOf() {
        const bytes = this.bytes.slice(0);
        const negative = bytes[0] & 0b10000000;
        if (negative) {
            negate$1(bytes);
        }
        return parseInt(toHex(bytes), 16) * (negative ? -1 : 1);
    }
    toString() {
        return String(this.valueOf());
    }
}
function negate$1(bytes) {
    for (let i = 0; i < 8; i++) {
        bytes[i] ^= 0xff;
    }
    for (let i = 7; i > -1; i--) {
        bytes[i]++;
        if (bytes[i] !== 0)
            break;
    }
}

const hasHeader$1 = (soughtHeader, headers) => {
    soughtHeader = soughtHeader.toLowerCase();
    for (const headerName of Object.keys(headers)) {
        if (soughtHeader === headerName.toLowerCase()) {
            return true;
        }
    }
    return false;
};

const moveHeadersToQuery = (request, options = {}) => {
    const { headers, query = {} } = HttpRequest.clone(request);
    for (const name of Object.keys(headers)) {
        const lname = name.toLowerCase();
        if ((lname.slice(0, 6) === "x-amz-" && !options.unhoistableHeaders?.has(lname)) ||
            options.hoistableHeaders?.has(lname)) {
            query[name] = headers[name];
            delete headers[name];
        }
    }
    return {
        ...request,
        headers,
        query,
    };
};

const prepareRequest = (request) => {
    request = HttpRequest.clone(request);
    for (const headerName of Object.keys(request.headers)) {
        if (GENERATED_HEADERS.indexOf(headerName.toLowerCase()) > -1) {
            delete request.headers[headerName];
        }
    }
    return request;
};

const iso8601 = (time) => toDate(time)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
const toDate = (time) => {
    if (typeof time === "number") {
        return new Date(time * 1000);
    }
    if (typeof time === "string") {
        if (Number(time)) {
            return new Date(Number(time) * 1000);
        }
        return new Date(time);
    }
    return time;
};

class SignatureV4 {
    constructor({ applyChecksum, credentials, region, service, sha256, uriEscapePath = true, }) {
        this.headerFormatter = new HeaderFormatter();
        this.service = service;
        this.sha256 = sha256;
        this.uriEscapePath = uriEscapePath;
        this.applyChecksum = typeof applyChecksum === "boolean" ? applyChecksum : true;
        this.regionProvider = normalizeProvider$1(region);
        this.credentialProvider = normalizeProvider$1(credentials);
    }
    async presign(originalRequest, options = {}) {
        const { signingDate = new Date(), expiresIn = 3600, unsignableHeaders, unhoistableHeaders, signableHeaders, hoistableHeaders, signingRegion, signingService, } = options;
        const credentials = await this.credentialProvider();
        this.validateResolvedCredentials(credentials);
        const region = signingRegion ?? (await this.regionProvider());
        const { longDate, shortDate } = formatDate(signingDate);
        if (expiresIn > MAX_PRESIGNED_TTL) {
            return Promise.reject("Signature version 4 presigned URLs" + " must have an expiration date less than one week in" + " the future");
        }
        const scope = createScope(shortDate, region, signingService ?? this.service);
        const request = moveHeadersToQuery(prepareRequest(originalRequest), { unhoistableHeaders, hoistableHeaders });
        if (credentials.sessionToken) {
            request.query[TOKEN_QUERY_PARAM] = credentials.sessionToken;
        }
        request.query[ALGORITHM_QUERY_PARAM] = ALGORITHM_IDENTIFIER;
        request.query[CREDENTIAL_QUERY_PARAM] = `${credentials.accessKeyId}/${scope}`;
        request.query[AMZ_DATE_QUERY_PARAM] = longDate;
        request.query[EXPIRES_QUERY_PARAM] = expiresIn.toString(10);
        const canonicalHeaders = getCanonicalHeaders(request, unsignableHeaders, signableHeaders);
        request.query[SIGNED_HEADERS_QUERY_PARAM] = getCanonicalHeaderList(canonicalHeaders);
        request.query[SIGNATURE_QUERY_PARAM] = await this.getSignature(longDate, scope, this.getSigningKey(credentials, region, shortDate, signingService), this.createCanonicalRequest(request, canonicalHeaders, await getPayloadHash(originalRequest, this.sha256)));
        return request;
    }
    async sign(toSign, options) {
        if (typeof toSign === "string") {
            return this.signString(toSign, options);
        }
        else if (toSign.headers && toSign.payload) {
            return this.signEvent(toSign, options);
        }
        else if (toSign.message) {
            return this.signMessage(toSign, options);
        }
        else {
            return this.signRequest(toSign, options);
        }
    }
    async signEvent({ headers, payload }, { signingDate = new Date(), priorSignature, signingRegion, signingService }) {
        const region = signingRegion ?? (await this.regionProvider());
        const { shortDate, longDate } = formatDate(signingDate);
        const scope = createScope(shortDate, region, signingService ?? this.service);
        const hashedPayload = await getPayloadHash({ headers: {}, body: payload }, this.sha256);
        const hash = new this.sha256();
        hash.update(headers);
        const hashedHeaders = toHex(await hash.digest());
        const stringToSign = [
            EVENT_ALGORITHM_IDENTIFIER,
            longDate,
            scope,
            priorSignature,
            hashedHeaders,
            hashedPayload,
        ].join("\n");
        return this.signString(stringToSign, { signingDate, signingRegion: region, signingService });
    }
    async signMessage(signableMessage, { signingDate = new Date(), signingRegion, signingService }) {
        const promise = this.signEvent({
            headers: this.headerFormatter.format(signableMessage.message.headers),
            payload: signableMessage.message.body,
        }, {
            signingDate,
            signingRegion,
            signingService,
            priorSignature: signableMessage.priorSignature,
        });
        return promise.then((signature) => {
            return { message: signableMessage.message, signature };
        });
    }
    async signString(stringToSign, { signingDate = new Date(), signingRegion, signingService } = {}) {
        const credentials = await this.credentialProvider();
        this.validateResolvedCredentials(credentials);
        const region = signingRegion ?? (await this.regionProvider());
        const { shortDate } = formatDate(signingDate);
        const hash = new this.sha256(await this.getSigningKey(credentials, region, shortDate, signingService));
        hash.update(toUint8Array(stringToSign));
        return toHex(await hash.digest());
    }
    async signRequest(requestToSign, { signingDate = new Date(), signableHeaders, unsignableHeaders, signingRegion, signingService, } = {}) {
        const credentials = await this.credentialProvider();
        this.validateResolvedCredentials(credentials);
        const region = signingRegion ?? (await this.regionProvider());
        const request = prepareRequest(requestToSign);
        const { longDate, shortDate } = formatDate(signingDate);
        const scope = createScope(shortDate, region, signingService ?? this.service);
        request.headers[AMZ_DATE_HEADER] = longDate;
        if (credentials.sessionToken) {
            request.headers[TOKEN_HEADER] = credentials.sessionToken;
        }
        const payloadHash = await getPayloadHash(request, this.sha256);
        if (!hasHeader$1(SHA256_HEADER, request.headers) && this.applyChecksum) {
            request.headers[SHA256_HEADER] = payloadHash;
        }
        const canonicalHeaders = getCanonicalHeaders(request, unsignableHeaders, signableHeaders);
        const signature = await this.getSignature(longDate, scope, this.getSigningKey(credentials, region, shortDate, signingService), this.createCanonicalRequest(request, canonicalHeaders, payloadHash));
        request.headers[AUTH_HEADER] =
            `${ALGORITHM_IDENTIFIER} ` +
                `Credential=${credentials.accessKeyId}/${scope}, ` +
                `SignedHeaders=${getCanonicalHeaderList(canonicalHeaders)}, ` +
                `Signature=${signature}`;
        return request;
    }
    createCanonicalRequest(request, canonicalHeaders, payloadHash) {
        const sortedHeaders = Object.keys(canonicalHeaders).sort();
        return `${request.method}
${this.getCanonicalPath(request)}
${getCanonicalQuery(request)}
${sortedHeaders.map((name) => `${name}:${canonicalHeaders[name]}`).join("\n")}

${sortedHeaders.join(";")}
${payloadHash}`;
    }
    async createStringToSign(longDate, credentialScope, canonicalRequest) {
        const hash = new this.sha256();
        hash.update(toUint8Array(canonicalRequest));
        const hashedRequest = await hash.digest();
        return `${ALGORITHM_IDENTIFIER}
${longDate}
${credentialScope}
${toHex(hashedRequest)}`;
    }
    getCanonicalPath({ path }) {
        if (this.uriEscapePath) {
            const normalizedPathSegments = [];
            for (const pathSegment of path.split("/")) {
                if (pathSegment?.length === 0)
                    continue;
                if (pathSegment === ".")
                    continue;
                if (pathSegment === "..") {
                    normalizedPathSegments.pop();
                }
                else {
                    normalizedPathSegments.push(pathSegment);
                }
            }
            const normalizedPath = `${path?.startsWith("/") ? "/" : ""}${normalizedPathSegments.join("/")}${normalizedPathSegments.length > 0 && path?.endsWith("/") ? "/" : ""}`;
            const doubleEncoded = escapeUri(normalizedPath);
            return doubleEncoded.replace(/%2F/g, "/");
        }
        return path;
    }
    async getSignature(longDate, credentialScope, keyPromise, canonicalRequest) {
        const stringToSign = await this.createStringToSign(longDate, credentialScope, canonicalRequest);
        const hash = new this.sha256(await keyPromise);
        hash.update(toUint8Array(stringToSign));
        return toHex(await hash.digest());
    }
    getSigningKey(credentials, region, shortDate, service) {
        return getSigningKey(this.sha256, credentials, shortDate, region, service || this.service);
    }
    validateResolvedCredentials(credentials) {
        if (typeof credentials !== "object" ||
            typeof credentials.accessKeyId !== "string" ||
            typeof credentials.secretAccessKey !== "string") {
            throw new Error("Resolved credential object is not valid");
        }
    }
}
const formatDate = (now) => {
    const longDate = iso8601(now).replace(/[\-:]/g, "");
    return {
        longDate,
        shortDate: longDate.slice(0, 8),
    };
};
const getCanonicalHeaderList = (headers) => Object.keys(headers).sort().join(";");

const resolveAwsSdkSigV4Config = (config) => {
    let isUserSupplied = false;
    let credentialsProvider;
    if (config.credentials) {
        isUserSupplied = true;
        credentialsProvider = memoizeIdentityProvider(config.credentials, isIdentityExpired, doesIdentityRequireRefresh);
    }
    if (!credentialsProvider) {
        if (config.credentialDefaultProvider) {
            credentialsProvider = normalizeProvider(config.credentialDefaultProvider(Object.assign({}, config, {
                parentClientConfig: config,
            })));
        }
        else {
            credentialsProvider = async () => {
                throw new Error("`credentials` is missing");
            };
        }
    }
    const boundCredentialsProvider = async () => credentialsProvider({ callerClientConfig: config });
    const { signingEscapePath = true, systemClockOffset = config.systemClockOffset || 0, sha256, } = config;
    let signer;
    if (config.signer) {
        signer = normalizeProvider(config.signer);
    }
    else if (config.regionInfoProvider) {
        signer = () => normalizeProvider(config.region)()
            .then(async (region) => [
            (await config.regionInfoProvider(region, {
                useFipsEndpoint: await config.useFipsEndpoint(),
                useDualstackEndpoint: await config.useDualstackEndpoint(),
            })) || {},
            region,
        ])
            .then(([regionInfo, region]) => {
            const { signingRegion, signingService } = regionInfo;
            config.signingRegion = config.signingRegion || signingRegion || region;
            config.signingName = config.signingName || signingService || config.serviceId;
            const params = {
                ...config,
                credentials: boundCredentialsProvider,
                region: config.signingRegion,
                service: config.signingName,
                sha256,
                uriEscapePath: signingEscapePath,
            };
            const SignerCtor = config.signerConstructor || SignatureV4;
            return new SignerCtor(params);
        });
    }
    else {
        signer = async (authScheme) => {
            authScheme = Object.assign({}, {
                name: "sigv4",
                signingName: config.signingName || config.defaultSigningName,
                signingRegion: await normalizeProvider(config.region)(),
                properties: {},
            }, authScheme);
            const signingRegion = authScheme.signingRegion;
            const signingService = authScheme.signingName;
            config.signingRegion = config.signingRegion || signingRegion;
            config.signingName = config.signingName || signingService || config.serviceId;
            const params = {
                ...config,
                credentials: boundCredentialsProvider,
                region: config.signingRegion,
                service: config.signingName,
                sha256,
                uriEscapePath: signingEscapePath,
            };
            const SignerCtor = config.signerConstructor || SignatureV4;
            return new SignerCtor(params);
        };
    }
    return {
        ...config,
        systemClockOffset,
        signingEscapePath,
        credentials: isUserSupplied
            ? async () => boundCredentialsProvider().then((creds) => setCredentialFeature(creds, "CREDENTIALS_CODE", "e"))
            : boundCredentialsProvider,
        signer,
    };
};

const getAllAliases = (name, aliases) => {
    const _aliases = [];
    if (name) {
        _aliases.push(name);
    }
    if (aliases) {
        for (const alias of aliases) {
            _aliases.push(alias);
        }
    }
    return _aliases;
};
const getMiddlewareNameWithAliases = (name, aliases) => {
    return `${name || "anonymous"}${aliases && aliases.length > 0 ? ` (a.k.a. ${aliases.join(",")})` : ""}`;
};
const constructStack = () => {
    let absoluteEntries = [];
    let relativeEntries = [];
    let identifyOnResolve = false;
    const entriesNameSet = new Set();
    const sort = (entries) => entries.sort((a, b) => stepWeights[b.step] - stepWeights[a.step] ||
        priorityWeights[b.priority || "normal"] - priorityWeights[a.priority || "normal"]);
    const removeByName = (toRemove) => {
        let isRemoved = false;
        const filterCb = (entry) => {
            const aliases = getAllAliases(entry.name, entry.aliases);
            if (aliases.includes(toRemove)) {
                isRemoved = true;
                for (const alias of aliases) {
                    entriesNameSet.delete(alias);
                }
                return false;
            }
            return true;
        };
        absoluteEntries = absoluteEntries.filter(filterCb);
        relativeEntries = relativeEntries.filter(filterCb);
        return isRemoved;
    };
    const removeByReference = (toRemove) => {
        let isRemoved = false;
        const filterCb = (entry) => {
            if (entry.middleware === toRemove) {
                isRemoved = true;
                for (const alias of getAllAliases(entry.name, entry.aliases)) {
                    entriesNameSet.delete(alias);
                }
                return false;
            }
            return true;
        };
        absoluteEntries = absoluteEntries.filter(filterCb);
        relativeEntries = relativeEntries.filter(filterCb);
        return isRemoved;
    };
    const cloneTo = (toStack) => {
        absoluteEntries.forEach((entry) => {
            toStack.add(entry.middleware, { ...entry });
        });
        relativeEntries.forEach((entry) => {
            toStack.addRelativeTo(entry.middleware, { ...entry });
        });
        toStack.identifyOnResolve?.(stack.identifyOnResolve());
        return toStack;
    };
    const expandRelativeMiddlewareList = (from) => {
        const expandedMiddlewareList = [];
        from.before.forEach((entry) => {
            if (entry.before.length === 0 && entry.after.length === 0) {
                expandedMiddlewareList.push(entry);
            }
            else {
                expandedMiddlewareList.push(...expandRelativeMiddlewareList(entry));
            }
        });
        expandedMiddlewareList.push(from);
        from.after.reverse().forEach((entry) => {
            if (entry.before.length === 0 && entry.after.length === 0) {
                expandedMiddlewareList.push(entry);
            }
            else {
                expandedMiddlewareList.push(...expandRelativeMiddlewareList(entry));
            }
        });
        return expandedMiddlewareList;
    };
    const getMiddlewareList = (debug = false) => {
        const normalizedAbsoluteEntries = [];
        const normalizedRelativeEntries = [];
        const normalizedEntriesNameMap = {};
        absoluteEntries.forEach((entry) => {
            const normalizedEntry = {
                ...entry,
                before: [],
                after: [],
            };
            for (const alias of getAllAliases(normalizedEntry.name, normalizedEntry.aliases)) {
                normalizedEntriesNameMap[alias] = normalizedEntry;
            }
            normalizedAbsoluteEntries.push(normalizedEntry);
        });
        relativeEntries.forEach((entry) => {
            const normalizedEntry = {
                ...entry,
                before: [],
                after: [],
            };
            for (const alias of getAllAliases(normalizedEntry.name, normalizedEntry.aliases)) {
                normalizedEntriesNameMap[alias] = normalizedEntry;
            }
            normalizedRelativeEntries.push(normalizedEntry);
        });
        normalizedRelativeEntries.forEach((entry) => {
            if (entry.toMiddleware) {
                const toMiddleware = normalizedEntriesNameMap[entry.toMiddleware];
                if (toMiddleware === undefined) {
                    if (debug) {
                        return;
                    }
                    throw new Error(`${entry.toMiddleware} is not found when adding ` +
                        `${getMiddlewareNameWithAliases(entry.name, entry.aliases)} ` +
                        `middleware ${entry.relation} ${entry.toMiddleware}`);
                }
                if (entry.relation === "after") {
                    toMiddleware.after.push(entry);
                }
                if (entry.relation === "before") {
                    toMiddleware.before.push(entry);
                }
            }
        });
        const mainChain = sort(normalizedAbsoluteEntries)
            .map(expandRelativeMiddlewareList)
            .reduce((wholeList, expandedMiddlewareList) => {
            wholeList.push(...expandedMiddlewareList);
            return wholeList;
        }, []);
        return mainChain;
    };
    const stack = {
        add: (middleware, options = {}) => {
            const { name, override, aliases: _aliases } = options;
            const entry = {
                step: "initialize",
                priority: "normal",
                middleware,
                ...options,
            };
            const aliases = getAllAliases(name, _aliases);
            if (aliases.length > 0) {
                if (aliases.some((alias) => entriesNameSet.has(alias))) {
                    if (!override)
                        throw new Error(`Duplicate middleware name '${getMiddlewareNameWithAliases(name, _aliases)}'`);
                    for (const alias of aliases) {
                        const toOverrideIndex = absoluteEntries.findIndex((entry) => entry.name === alias || entry.aliases?.some((a) => a === alias));
                        if (toOverrideIndex === -1) {
                            continue;
                        }
                        const toOverride = absoluteEntries[toOverrideIndex];
                        if (toOverride.step !== entry.step || entry.priority !== toOverride.priority) {
                            throw new Error(`"${getMiddlewareNameWithAliases(toOverride.name, toOverride.aliases)}" middleware with ` +
                                `${toOverride.priority} priority in ${toOverride.step} step cannot ` +
                                `be overridden by "${getMiddlewareNameWithAliases(name, _aliases)}" middleware with ` +
                                `${entry.priority} priority in ${entry.step} step.`);
                        }
                        absoluteEntries.splice(toOverrideIndex, 1);
                    }
                }
                for (const alias of aliases) {
                    entriesNameSet.add(alias);
                }
            }
            absoluteEntries.push(entry);
        },
        addRelativeTo: (middleware, options) => {
            const { name, override, aliases: _aliases } = options;
            const entry = {
                middleware,
                ...options,
            };
            const aliases = getAllAliases(name, _aliases);
            if (aliases.length > 0) {
                if (aliases.some((alias) => entriesNameSet.has(alias))) {
                    if (!override)
                        throw new Error(`Duplicate middleware name '${getMiddlewareNameWithAliases(name, _aliases)}'`);
                    for (const alias of aliases) {
                        const toOverrideIndex = relativeEntries.findIndex((entry) => entry.name === alias || entry.aliases?.some((a) => a === alias));
                        if (toOverrideIndex === -1) {
                            continue;
                        }
                        const toOverride = relativeEntries[toOverrideIndex];
                        if (toOverride.toMiddleware !== entry.toMiddleware || toOverride.relation !== entry.relation) {
                            throw new Error(`"${getMiddlewareNameWithAliases(toOverride.name, toOverride.aliases)}" middleware ` +
                                `${toOverride.relation} "${toOverride.toMiddleware}" middleware cannot be overridden ` +
                                `by "${getMiddlewareNameWithAliases(name, _aliases)}" middleware ${entry.relation} ` +
                                `"${entry.toMiddleware}" middleware.`);
                        }
                        relativeEntries.splice(toOverrideIndex, 1);
                    }
                }
                for (const alias of aliases) {
                    entriesNameSet.add(alias);
                }
            }
            relativeEntries.push(entry);
        },
        clone: () => cloneTo(constructStack()),
        use: (plugin) => {
            plugin.applyToStack(stack);
        },
        remove: (toRemove) => {
            if (typeof toRemove === "string")
                return removeByName(toRemove);
            else
                return removeByReference(toRemove);
        },
        removeByTag: (toRemove) => {
            let isRemoved = false;
            const filterCb = (entry) => {
                const { tags, name, aliases: _aliases } = entry;
                if (tags && tags.includes(toRemove)) {
                    const aliases = getAllAliases(name, _aliases);
                    for (const alias of aliases) {
                        entriesNameSet.delete(alias);
                    }
                    isRemoved = true;
                    return false;
                }
                return true;
            };
            absoluteEntries = absoluteEntries.filter(filterCb);
            relativeEntries = relativeEntries.filter(filterCb);
            return isRemoved;
        },
        concat: (from) => {
            const cloned = cloneTo(constructStack());
            cloned.use(from);
            cloned.identifyOnResolve(identifyOnResolve || cloned.identifyOnResolve() || (from.identifyOnResolve?.() ?? false));
            return cloned;
        },
        applyToStack: cloneTo,
        identify: () => {
            return getMiddlewareList(true).map((mw) => {
                const step = mw.step ??
                    mw.relation +
                        " " +
                        mw.toMiddleware;
                return getMiddlewareNameWithAliases(mw.name, mw.aliases) + " - " + step;
            });
        },
        identifyOnResolve(toggle) {
            if (typeof toggle === "boolean")
                identifyOnResolve = toggle;
            return identifyOnResolve;
        },
        resolve: (handler, context) => {
            for (const middleware of getMiddlewareList()
                .map((entry) => entry.middleware)
                .reverse()) {
                handler = middleware(handler, context);
            }
            if (identifyOnResolve) {
                console.log(stack.identify());
            }
            return handler;
        },
    };
    return stack;
};
const stepWeights = {
    initialize: 5,
    serialize: 4,
    build: 3,
    finalizeRequest: 2,
    deserialize: 1,
};
const priorityWeights = {
    high: 3,
    normal: 2,
    low: 1,
};

class Client {
    constructor(config) {
        this.config = config;
        this.middlewareStack = constructStack();
    }
    send(command, optionsOrCb, cb) {
        const options = typeof optionsOrCb !== "function" ? optionsOrCb : undefined;
        const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
        const useHandlerCache = options === undefined && this.config.cacheMiddleware === true;
        let handler;
        if (useHandlerCache) {
            if (!this.handlers) {
                this.handlers = new WeakMap();
            }
            const handlers = this.handlers;
            if (handlers.has(command.constructor)) {
                handler = handlers.get(command.constructor);
            }
            else {
                handler = command.resolveMiddleware(this.middlewareStack, this.config, options);
                handlers.set(command.constructor, handler);
            }
        }
        else {
            delete this.handlers;
            handler = command.resolveMiddleware(this.middlewareStack, this.config, options);
        }
        if (callback) {
            handler(command)
                .then((result) => callback(null, result.output), (err) => callback(err))
                .catch(() => { });
        }
        else {
            return handler(command).then((result) => result.output);
        }
    }
    destroy() {
        this.config?.requestHandler?.destroy?.();
        delete this.handlers;
    }
}

class Command {
    constructor() {
        this.middlewareStack = constructStack();
    }
    static classBuilder() {
        return new ClassBuilder();
    }
    resolveMiddlewareWithContext(clientStack, configuration, options, { middlewareFn, clientName, commandName, inputFilterSensitiveLog, outputFilterSensitiveLog, smithyContext, additionalContext, CommandCtor, }) {
        for (const mw of middlewareFn.bind(this)(CommandCtor, clientStack, configuration, options)) {
            this.middlewareStack.use(mw);
        }
        const stack = clientStack.concat(this.middlewareStack);
        const { logger } = configuration;
        const handlerExecutionContext = {
            logger,
            clientName,
            commandName,
            inputFilterSensitiveLog,
            outputFilterSensitiveLog,
            [SMITHY_CONTEXT_KEY]: {
                commandInstance: this,
                ...smithyContext,
            },
            ...additionalContext,
        };
        const { requestHandler } = configuration;
        return stack.resolve((request) => requestHandler.handle(request.request, options || {}), handlerExecutionContext);
    }
}
class ClassBuilder {
    constructor() {
        this._init = () => { };
        this._ep = {};
        this._middlewareFn = () => [];
        this._commandName = "";
        this._clientName = "";
        this._additionalContext = {};
        this._smithyContext = {};
        this._inputFilterSensitiveLog = (_) => _;
        this._outputFilterSensitiveLog = (_) => _;
        this._serializer = null;
        this._deserializer = null;
    }
    init(cb) {
        this._init = cb;
    }
    ep(endpointParameterInstructions) {
        this._ep = endpointParameterInstructions;
        return this;
    }
    m(middlewareSupplier) {
        this._middlewareFn = middlewareSupplier;
        return this;
    }
    s(service, operation, smithyContext = {}) {
        this._smithyContext = {
            service,
            operation,
            ...smithyContext,
        };
        return this;
    }
    c(additionalContext = {}) {
        this._additionalContext = additionalContext;
        return this;
    }
    n(clientName, commandName) {
        this._clientName = clientName;
        this._commandName = commandName;
        return this;
    }
    f(inputFilter = (_) => _, outputFilter = (_) => _) {
        this._inputFilterSensitiveLog = inputFilter;
        this._outputFilterSensitiveLog = outputFilter;
        return this;
    }
    ser(serializer) {
        this._serializer = serializer;
        return this;
    }
    de(deserializer) {
        this._deserializer = deserializer;
        return this;
    }
    build() {
        const closure = this;
        let CommandRef;
        return (CommandRef = class extends Command {
            static getEndpointParameterInstructions() {
                return closure._ep;
            }
            constructor(...[input]) {
                super();
                this.serialize = closure._serializer;
                this.deserialize = closure._deserializer;
                this.input = input ?? {};
                closure._init(this);
            }
            resolveMiddleware(stack, configuration, options) {
                return this.resolveMiddlewareWithContext(stack, configuration, options, {
                    CommandCtor: CommandRef,
                    middlewareFn: closure._middlewareFn,
                    clientName: closure._clientName,
                    commandName: closure._commandName,
                    inputFilterSensitiveLog: closure._inputFilterSensitiveLog,
                    outputFilterSensitiveLog: closure._outputFilterSensitiveLog,
                    smithyContext: closure._smithyContext,
                    additionalContext: closure._additionalContext,
                });
            }
        });
    }
}

const SENSITIVE_STRING = "***SensitiveInformation***";

const createAggregatedClient = (commands, Client) => {
    for (const command of Object.keys(commands)) {
        const CommandCtor = commands[command];
        const methodImpl = async function (args, optionsOrCb, cb) {
            const command = new CommandCtor(args);
            if (typeof optionsOrCb === "function") {
                this.send(command, optionsOrCb);
            }
            else if (typeof cb === "function") {
                if (typeof optionsOrCb !== "object")
                    throw new Error(`Expected http options but got ${typeof optionsOrCb}`);
                this.send(command, optionsOrCb || {}, cb);
            }
            else {
                return this.send(command, optionsOrCb);
            }
        };
        const methodName = (command[0].toLowerCase() + command.slice(1)).replace(/Command$/, "");
        Client.prototype[methodName] = methodImpl;
    }
};

const parseBoolean = (value) => {
    switch (value) {
        case "true":
            return true;
        case "false":
            return false;
        default:
            throw new Error(`Unable to parse boolean value "${value}"`);
    }
};
const expectNumber = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === "string") {
        const parsed = parseFloat(value);
        if (!Number.isNaN(parsed)) {
            if (String(parsed) !== String(value)) {
                logger.warn(stackTraceWarning(`Expected number but observed string: ${value}`));
            }
            return parsed;
        }
    }
    if (typeof value === "number") {
        return value;
    }
    throw new TypeError(`Expected number, got ${typeof value}: ${value}`);
};
const MAX_FLOAT = Math.ceil(2 ** 127 * (2 - 2 ** -23));
const expectFloat32 = (value) => {
    const expected = expectNumber(value);
    if (expected !== undefined && !Number.isNaN(expected) && expected !== Infinity && expected !== -Infinity) {
        if (Math.abs(expected) > MAX_FLOAT) {
            throw new TypeError(`Expected 32-bit float, got ${value}`);
        }
    }
    return expected;
};
const expectLong = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (Number.isInteger(value) && !Number.isNaN(value)) {
        return value;
    }
    throw new TypeError(`Expected integer, got ${typeof value}: ${value}`);
};
const expectInt32 = (value) => expectSizedInt(value, 32);
const expectShort = (value) => expectSizedInt(value, 16);
const expectByte = (value) => expectSizedInt(value, 8);
const expectSizedInt = (value, size) => {
    const expected = expectLong(value);
    if (expected !== undefined && castInt(expected, size) !== expected) {
        throw new TypeError(`Expected ${size}-bit integer, got ${value}`);
    }
    return expected;
};
const castInt = (value, size) => {
    switch (size) {
        case 32:
            return Int32Array.of(value)[0];
        case 16:
            return Int16Array.of(value)[0];
        case 8:
            return Int8Array.of(value)[0];
    }
};
const expectNonNull = (value, location) => {
    if (value === null || value === undefined) {
        if (location) {
            throw new TypeError(`Expected a non-null value for ${location}`);
        }
        throw new TypeError("Expected a non-null value");
    }
    return value;
};
const expectObject = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    const receivedType = Array.isArray(value) ? "array" : typeof value;
    throw new TypeError(`Expected object, got ${receivedType}: ${value}`);
};
const expectString = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    if (["boolean", "number", "bigint"].includes(typeof value)) {
        logger.warn(stackTraceWarning(`Expected string, got ${typeof value}: ${value}`));
        return String(value);
    }
    throw new TypeError(`Expected string, got ${typeof value}: ${value}`);
};
const strictParseFloat32 = (value) => {
    if (typeof value == "string") {
        return expectFloat32(parseNumber(value));
    }
    return expectFloat32(value);
};
const NUMBER_REGEX = /(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(-?Infinity)|(NaN)/g;
const parseNumber = (value) => {
    const matches = value.match(NUMBER_REGEX);
    if (matches === null || matches[0].length !== value.length) {
        throw new TypeError(`Expected real number, got implicit NaN`);
    }
    return parseFloat(value);
};
const strictParseLong = (value) => {
    if (typeof value === "string") {
        return expectLong(parseNumber(value));
    }
    return expectLong(value);
};
const strictParseInt32 = (value) => {
    if (typeof value === "string") {
        return expectInt32(parseNumber(value));
    }
    return expectInt32(value);
};
const strictParseShort = (value) => {
    if (typeof value === "string") {
        return expectShort(parseNumber(value));
    }
    return expectShort(value);
};
const strictParseByte = (value) => {
    if (typeof value === "string") {
        return expectByte(parseNumber(value));
    }
    return expectByte(value);
};
const stackTraceWarning = (message) => {
    return String(new TypeError(message).stack || message)
        .split("\n")
        .slice(0, 5)
        .filter((s) => !s.includes("stackTraceWarning"))
        .join("\n");
};
const logger = {
    warn: console.warn,
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateToUtcString(date) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const dayOfWeek = date.getUTCDay();
    const dayOfMonthInt = date.getUTCDate();
    const hoursInt = date.getUTCHours();
    const minutesInt = date.getUTCMinutes();
    const secondsInt = date.getUTCSeconds();
    const dayOfMonthString = dayOfMonthInt < 10 ? `0${dayOfMonthInt}` : `${dayOfMonthInt}`;
    const hoursString = hoursInt < 10 ? `0${hoursInt}` : `${hoursInt}`;
    const minutesString = minutesInt < 10 ? `0${minutesInt}` : `${minutesInt}`;
    const secondsString = secondsInt < 10 ? `0${secondsInt}` : `${secondsInt}`;
    return `${DAYS[dayOfWeek]}, ${dayOfMonthString} ${MONTHS[month]} ${year} ${hoursString}:${minutesString}:${secondsString} GMT`;
}
const RFC3339 = new RegExp(/^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?[zZ]$/);
const parseRfc3339DateTime = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new TypeError("RFC-3339 date-times must be expressed as strings");
    }
    const match = RFC3339.exec(value);
    if (!match) {
        throw new TypeError("Invalid RFC-3339 date-time value");
    }
    const [_, yearStr, monthStr, dayStr, hours, minutes, seconds, fractionalMilliseconds] = match;
    const year = strictParseShort(stripLeadingZeroes(yearStr));
    const month = parseDateValue(monthStr, "month", 1, 12);
    const day = parseDateValue(dayStr, "day", 1, 31);
    return buildDate(year, month, day, { hours, minutes, seconds, fractionalMilliseconds });
};
const RFC3339_WITH_OFFSET = new RegExp(/^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(([-+]\d{2}\:\d{2})|[zZ])$/);
const parseRfc3339DateTimeWithOffset = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new TypeError("RFC-3339 date-times must be expressed as strings");
    }
    const match = RFC3339_WITH_OFFSET.exec(value);
    if (!match) {
        throw new TypeError("Invalid RFC-3339 date-time value");
    }
    const [_, yearStr, monthStr, dayStr, hours, minutes, seconds, fractionalMilliseconds, offsetStr] = match;
    const year = strictParseShort(stripLeadingZeroes(yearStr));
    const month = parseDateValue(monthStr, "month", 1, 12);
    const day = parseDateValue(dayStr, "day", 1, 31);
    const date = buildDate(year, month, day, { hours, minutes, seconds, fractionalMilliseconds });
    if (offsetStr.toUpperCase() != "Z") {
        date.setTime(date.getTime() - parseOffsetToMilliseconds(offsetStr));
    }
    return date;
};
const IMF_FIXDATE = new RegExp(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? GMT$/);
const RFC_850_DATE = new RegExp(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? GMT$/);
const ASC_TIME = new RegExp(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{4})$/);
const parseRfc7231DateTime = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new TypeError("RFC-7231 date-times must be expressed as strings");
    }
    let match = IMF_FIXDATE.exec(value);
    if (match) {
        const [_, dayStr, monthStr, yearStr, hours, minutes, seconds, fractionalMilliseconds] = match;
        return buildDate(strictParseShort(stripLeadingZeroes(yearStr)), parseMonthByShortName(monthStr), parseDateValue(dayStr, "day", 1, 31), { hours, minutes, seconds, fractionalMilliseconds });
    }
    match = RFC_850_DATE.exec(value);
    if (match) {
        const [_, dayStr, monthStr, yearStr, hours, minutes, seconds, fractionalMilliseconds] = match;
        return adjustRfc850Year(buildDate(parseTwoDigitYear(yearStr), parseMonthByShortName(monthStr), parseDateValue(dayStr, "day", 1, 31), {
            hours,
            minutes,
            seconds,
            fractionalMilliseconds,
        }));
    }
    match = ASC_TIME.exec(value);
    if (match) {
        const [_, monthStr, dayStr, hours, minutes, seconds, fractionalMilliseconds, yearStr] = match;
        return buildDate(strictParseShort(stripLeadingZeroes(yearStr)), parseMonthByShortName(monthStr), parseDateValue(dayStr.trimLeft(), "day", 1, 31), { hours, minutes, seconds, fractionalMilliseconds });
    }
    throw new TypeError("Invalid RFC-7231 date-time value");
};
const buildDate = (year, month, day, time) => {
    const adjustedMonth = month - 1;
    validateDayOfMonth(year, adjustedMonth, day);
    return new Date(Date.UTC(year, adjustedMonth, day, parseDateValue(time.hours, "hour", 0, 23), parseDateValue(time.minutes, "minute", 0, 59), parseDateValue(time.seconds, "seconds", 0, 60), parseMilliseconds(time.fractionalMilliseconds)));
};
const parseTwoDigitYear = (value) => {
    const thisYear = new Date().getUTCFullYear();
    const valueInThisCentury = Math.floor(thisYear / 100) * 100 + strictParseShort(stripLeadingZeroes(value));
    if (valueInThisCentury < thisYear) {
        return valueInThisCentury + 100;
    }
    return valueInThisCentury;
};
const FIFTY_YEARS_IN_MILLIS = 50 * 365 * 24 * 60 * 60 * 1000;
const adjustRfc850Year = (input) => {
    if (input.getTime() - new Date().getTime() > FIFTY_YEARS_IN_MILLIS) {
        return new Date(Date.UTC(input.getUTCFullYear() - 100, input.getUTCMonth(), input.getUTCDate(), input.getUTCHours(), input.getUTCMinutes(), input.getUTCSeconds(), input.getUTCMilliseconds()));
    }
    return input;
};
const parseMonthByShortName = (value) => {
    const monthIdx = MONTHS.indexOf(value);
    if (monthIdx < 0) {
        throw new TypeError(`Invalid month: ${value}`);
    }
    return monthIdx + 1;
};
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validateDayOfMonth = (year, month, day) => {
    let maxDays = DAYS_IN_MONTH[month];
    if (month === 1 && isLeapYear(year)) {
        maxDays = 29;
    }
    if (day > maxDays) {
        throw new TypeError(`Invalid day for ${MONTHS[month]} in ${year}: ${day}`);
    }
};
const isLeapYear = (year) => {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
};
const parseDateValue = (value, type, lower, upper) => {
    const dateVal = strictParseByte(stripLeadingZeroes(value));
    if (dateVal < lower || dateVal > upper) {
        throw new TypeError(`${type} must be between ${lower} and ${upper}, inclusive`);
    }
    return dateVal;
};
const parseMilliseconds = (value) => {
    if (value === null || value === undefined) {
        return 0;
    }
    return strictParseFloat32("0." + value) * 1000;
};
const parseOffsetToMilliseconds = (value) => {
    const directionStr = value[0];
    let direction = 1;
    if (directionStr == "+") {
        direction = 1;
    }
    else if (directionStr == "-") {
        direction = -1;
    }
    else {
        throw new TypeError(`Offset direction, ${directionStr}, must be "+" or "-"`);
    }
    const hour = Number(value.substring(1, 3));
    const minute = Number(value.substring(4, 6));
    return direction * (hour * 60 + minute) * 60 * 1000;
};
const stripLeadingZeroes = (value) => {
    let idx = 0;
    while (idx < value.length - 1 && value.charAt(idx) === "0") {
        idx++;
    }
    if (idx === 0) {
        return value;
    }
    return value.slice(idx);
};

class ServiceException extends Error {
    constructor(options) {
        super(options.message);
        Object.setPrototypeOf(this, Object.getPrototypeOf(this).constructor.prototype);
        this.name = options.name;
        this.$fault = options.$fault;
        this.$metadata = options.$metadata;
    }
    static isInstance(value) {
        if (!value)
            return false;
        const candidate = value;
        return (ServiceException.prototype.isPrototypeOf(candidate) ||
            (Boolean(candidate.$fault) &&
                Boolean(candidate.$metadata) &&
                (candidate.$fault === "client" || candidate.$fault === "server")));
    }
    static [Symbol.hasInstance](instance) {
        if (!instance)
            return false;
        const candidate = instance;
        if (this === ServiceException) {
            return ServiceException.isInstance(instance);
        }
        if (ServiceException.isInstance(instance)) {
            if (candidate.name && this.name) {
                return this.prototype.isPrototypeOf(instance) || candidate.name === this.name;
            }
            return this.prototype.isPrototypeOf(instance);
        }
        return false;
    }
}
const decorateServiceException = (exception, additions = {}) => {
    Object.entries(additions)
        .filter(([, v]) => v !== undefined)
        .forEach(([k, v]) => {
        if (exception[k] == undefined || exception[k] === "") {
            exception[k] = v;
        }
    });
    const message = exception.message || exception.Message || "UnknownError";
    exception.message = message;
    delete exception.Message;
    return exception;
};

const throwDefaultError$1 = ({ output, parsedBody, exceptionCtor, errorCode }) => {
    const $metadata = deserializeMetadata$1(output);
    const statusCode = $metadata.httpStatusCode ? $metadata.httpStatusCode + "" : undefined;
    const response = new exceptionCtor({
        name: parsedBody?.code || parsedBody?.Code || errorCode || statusCode || "UnknownError",
        $fault: "client",
        $metadata,
    });
    throw decorateServiceException(response, parsedBody);
};
const withBaseException = (ExceptionCtor) => {
    return ({ output, parsedBody, errorCode }) => {
        throwDefaultError$1({ output, parsedBody, exceptionCtor: ExceptionCtor, errorCode });
    };
};
const deserializeMetadata$1 = (output) => ({
    httpStatusCode: output.statusCode,
    requestId: output.headers["x-amzn-requestid"] ?? output.headers["x-amzn-request-id"] ?? output.headers["x-amz-request-id"],
    extendedRequestId: output.headers["x-amz-id-2"],
    cfId: output.headers["x-amz-cf-id"],
});

const loadConfigsForDefaultMode = (mode) => {
    switch (mode) {
        case "standard":
            return {
                retryMode: "standard",
                connectionTimeout: 3100,
            };
        case "in-region":
            return {
                retryMode: "standard",
                connectionTimeout: 1100,
            };
        case "cross-region":
            return {
                retryMode: "standard",
                connectionTimeout: 3100,
            };
        case "mobile":
            return {
                retryMode: "standard",
                connectionTimeout: 30000,
            };
        default:
            return {};
    }
};

let warningEmitted = false;
const emitWarningIfUnsupportedVersion = (version) => {
    if (version && !warningEmitted && parseInt(version.substring(1, version.indexOf("."))) < 16) {
        warningEmitted = true;
    }
};

const getChecksumConfiguration = (runtimeConfig) => {
    const checksumAlgorithms = [];
    for (const id in AlgorithmId) {
        const algorithmId = AlgorithmId[id];
        if (runtimeConfig[algorithmId] === undefined) {
            continue;
        }
        checksumAlgorithms.push({
            algorithmId: () => algorithmId,
            checksumConstructor: () => runtimeConfig[algorithmId],
        });
    }
    return {
        _checksumAlgorithms: checksumAlgorithms,
        addChecksumAlgorithm(algo) {
            this._checksumAlgorithms.push(algo);
        },
        checksumAlgorithms() {
            return this._checksumAlgorithms;
        },
    };
};
const resolveChecksumRuntimeConfig = (clientConfig) => {
    const runtimeConfig = {};
    clientConfig.checksumAlgorithms().forEach((checksumAlgorithm) => {
        runtimeConfig[checksumAlgorithm.algorithmId()] = checksumAlgorithm.checksumConstructor();
    });
    return runtimeConfig;
};

const getRetryConfiguration = (runtimeConfig) => {
    let _retryStrategy = runtimeConfig.retryStrategy;
    return {
        setRetryStrategy(retryStrategy) {
            _retryStrategy = retryStrategy;
        },
        retryStrategy() {
            return _retryStrategy;
        },
    };
};
const resolveRetryRuntimeConfig = (retryStrategyConfiguration) => {
    const runtimeConfig = {};
    runtimeConfig.retryStrategy = retryStrategyConfiguration.retryStrategy();
    return runtimeConfig;
};

const getDefaultExtensionConfiguration = (runtimeConfig) => {
    return {
        ...getChecksumConfiguration(runtimeConfig),
        ...getRetryConfiguration(runtimeConfig),
    };
};
const resolveDefaultRuntimeConfig = (config) => {
    return {
        ...resolveChecksumRuntimeConfig(config),
        ...resolveRetryRuntimeConfig(config),
    };
};

const getValueFromTextNode = (obj) => {
    const textNodeName = "#text";
    for (const key in obj) {
        if (obj.hasOwnProperty(key) && obj[key][textNodeName] !== undefined) {
            obj[key] = obj[key][textNodeName];
        }
        else if (typeof obj[key] === "object" && obj[key] !== null) {
            obj[key] = getValueFromTextNode(obj[key]);
        }
    }
    return obj;
};

const isSerializableHeaderValue = (value) => {
    return value != null;
};

class NoOpLogger {
    trace() { }
    debug() { }
    info() { }
    warn() { }
    error() { }
}

function map(arg0, arg1, arg2) {
    let target;
    let filter;
    let instructions;
    if (typeof arg1 === "undefined" && typeof arg2 === "undefined") {
        target = {};
        instructions = arg0;
    }
    else {
        target = arg0;
        if (typeof arg1 === "function") {
            filter = arg1;
            instructions = arg2;
            return mapWithFilter(target, filter, instructions);
        }
        else {
            instructions = arg1;
        }
    }
    for (const key of Object.keys(instructions)) {
        if (!Array.isArray(instructions[key])) {
            target[key] = instructions[key];
            continue;
        }
        applyInstruction(target, null, instructions, key);
    }
    return target;
}
const take = (source, instructions) => {
    const out = {};
    for (const key in instructions) {
        applyInstruction(out, source, instructions, key);
    }
    return out;
};
const mapWithFilter = (target, filter, instructions) => {
    return map(target, Object.entries(instructions).reduce((_instructions, [key, value]) => {
        if (Array.isArray(value)) {
            _instructions[key] = value;
        }
        else {
            if (typeof value === "function") {
                _instructions[key] = [filter, value()];
            }
            else {
                _instructions[key] = [filter, value];
            }
        }
        return _instructions;
    }, {}));
};
const applyInstruction = (target, source, instructions, targetKey) => {
    if (source !== null) {
        let instruction = instructions[targetKey];
        if (typeof instruction === "function") {
            instruction = [, instruction];
        }
        const [filter = nonNullish, valueFn = pass, sourceKey = targetKey] = instruction;
        if ((typeof filter === "function" && filter(source[sourceKey])) || (typeof filter !== "function" && !!filter)) {
            target[targetKey] = valueFn(source[sourceKey]);
        }
        return;
    }
    let [filter, value] = instructions[targetKey];
    if (typeof value === "function") {
        let _value;
        const defaultFilterPassed = filter === undefined && (_value = value()) != null;
        const customFilterPassed = (typeof filter === "function" && !!filter(void 0)) || (typeof filter !== "function" && !!filter);
        if (defaultFilterPassed) {
            target[targetKey] = _value;
        }
        else if (customFilterPassed) {
            target[targetKey] = value();
        }
    }
    else {
        const defaultFilterPassed = filter === undefined && value != null;
        const customFilterPassed = (typeof filter === "function" && !!filter(value)) || (typeof filter !== "function" && !!filter);
        if (defaultFilterPassed || customFilterPassed) {
            target[targetKey] = value;
        }
    }
};
const nonNullish = (_) => _ != null;
const pass = (_) => _;

const _json = (obj) => {
    if (obj == null) {
        return {};
    }
    if (Array.isArray(obj)) {
        return obj.filter((_) => _ != null).map(_json);
    }
    if (typeof obj === "object") {
        const target = {};
        for (const key of Object.keys(obj)) {
            if (obj[key] == null) {
                continue;
            }
            target[key] = _json(obj[key]);
        }
        return target;
    }
    return obj;
};

const collectBodyString = (streamBody, context) => collectBody$1(streamBody, context).then((body) => context.utf8Encoder(body));

const parseJsonBody = (streamBody, context) => collectBodyString(streamBody, context).then((encoded) => {
    if (encoded.length) {
        try {
            return JSON.parse(encoded);
        }
        catch (e) {
            if (e?.name === "SyntaxError") {
                Object.defineProperty(e, "$responseBodyText", {
                    value: encoded,
                });
            }
            throw e;
        }
    }
    return {};
});
const parseJsonErrorBody = async (errorBody, context) => {
    const value = await parseJsonBody(errorBody, context);
    value.message = value.message ?? value.Message;
    return value;
};
const loadRestJsonErrorCode = (output, data) => {
    const findKey = (object, key) => Object.keys(object).find((k) => k.toLowerCase() === key.toLowerCase());
    const sanitizeErrorCode = (rawValue) => {
        let cleanValue = rawValue;
        if (typeof cleanValue === "number") {
            cleanValue = cleanValue.toString();
        }
        if (cleanValue.indexOf(",") >= 0) {
            cleanValue = cleanValue.split(",")[0];
        }
        if (cleanValue.indexOf(":") >= 0) {
            cleanValue = cleanValue.split(":")[0];
        }
        if (cleanValue.indexOf("#") >= 0) {
            cleanValue = cleanValue.split("#")[1];
        }
        return cleanValue;
    };
    const headerKey = findKey(output.headers, "x-amzn-errortype");
    if (headerKey !== undefined) {
        return sanitizeErrorCode(output.headers[headerKey]);
    }
    if (data.code !== undefined) {
        return sanitizeErrorCode(data.code);
    }
    if (data["__type"] !== undefined) {
        return sanitizeErrorCode(data["__type"]);
    }
};

var validator$2 = {};

var util$3 = {};

(function (exports) {

const nameStartChar = ':A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const nameChar = nameStartChar + '\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
const nameRegexp = '[' + nameStartChar + '][' + nameChar + ']*';
const regexName = new RegExp('^' + nameRegexp + '$');

const getAllMatches = function(string, regex) {
  const matches = [];
  let match = regex.exec(string);
  while (match) {
    const allmatches = [];
    allmatches.startIndex = regex.lastIndex - match[0].length;
    const len = match.length;
    for (let index = 0; index < len; index++) {
      allmatches.push(match[index]);
    }
    matches.push(allmatches);
    match = regex.exec(string);
  }
  return matches;
};

const isName = function(string) {
  const match = regexName.exec(string);
  return !(match === null || typeof match === 'undefined');
};

exports.isExist = function(v) {
  return typeof v !== 'undefined';
};

exports.isEmptyObject = function(obj) {
  return Object.keys(obj).length === 0;
};

/**
 * Copy all the properties of a into b.
 * @param {*} target
 * @param {*} a
 */
exports.merge = function(target, a, arrayMode) {
  if (a) {
    const keys = Object.keys(a); // will return an array of own properties
    const len = keys.length; //don't make it inline
    for (let i = 0; i < len; i++) {
      if (arrayMode === 'strict') {
        target[keys[i]] = [ a[keys[i]] ];
      } else {
        target[keys[i]] = a[keys[i]];
      }
    }
  }
};
/* exports.merge =function (b,a){
  return Object.assign(b,a);
} */

exports.getValue = function(v) {
  if (exports.isExist(v)) {
    return v;
  } else {
    return '';
  }
};

// const fakeCall = function(a) {return a;};
// const fakeCallNoReturn = function() {};

exports.isName = isName;
exports.getAllMatches = getAllMatches;
exports.nameRegexp = nameRegexp;
}(util$3));

const util$2 = util$3;

const defaultOptions$2 = {
  allowBooleanAttributes: false, //A tag can have attributes without any value
  unpairedTags: []
};

//const tagsPattern = new RegExp("<\\/?([\\w:\\-_\.]+)\\s*\/?>","g");
validator$2.validate = function (xmlData, options) {
  options = Object.assign({}, defaultOptions$2, options);

  //xmlData = xmlData.replace(/(\r\n|\n|\r)/gm,"");//make it single line
  //xmlData = xmlData.replace(/(^\s*<\?xml.*?\?>)/g,"");//Remove XML starting tag
  //xmlData = xmlData.replace(/(<!DOCTYPE[\s\w\"\.\/\-\:]+(\[.*\])*\s*>)/g,"");//Remove DOCTYPE
  const tags = [];
  let tagFound = false;

  //indicates that the root tag has been closed (aka. depth 0 has been reached)
  let reachedRoot = false;

  if (xmlData[0] === '\ufeff') {
    // check for byte order mark (BOM)
    xmlData = xmlData.substr(1);
  }
  
  for (let i = 0; i < xmlData.length; i++) {

    if (xmlData[i] === '<' && xmlData[i+1] === '?') {
      i+=2;
      i = readPI(xmlData,i);
      if (i.err) return i;
    }else if (xmlData[i] === '<') {
      //starting of tag
      //read until you reach to '>' avoiding any '>' in attribute value
      let tagStartPos = i;
      i++;
      
      if (xmlData[i] === '!') {
        i = readCommentAndCDATA(xmlData, i);
        continue;
      } else {
        let closingTag = false;
        if (xmlData[i] === '/') {
          //closing tag
          closingTag = true;
          i++;
        }
        //read tagname
        let tagName = '';
        for (; i < xmlData.length &&
          xmlData[i] !== '>' &&
          xmlData[i] !== ' ' &&
          xmlData[i] !== '\t' &&
          xmlData[i] !== '\n' &&
          xmlData[i] !== '\r'; i++
        ) {
          tagName += xmlData[i];
        }
        tagName = tagName.trim();
        //console.log(tagName);

        if (tagName[tagName.length - 1] === '/') {
          //self closing tag without attributes
          tagName = tagName.substring(0, tagName.length - 1);
          //continue;
          i--;
        }
        if (!validateTagName(tagName)) {
          let msg;
          if (tagName.trim().length === 0) {
            msg = "Invalid space after '<'.";
          } else {
            msg = "Tag '"+tagName+"' is an invalid name.";
          }
          return getErrorObject('InvalidTag', msg, getLineNumberForPosition(xmlData, i));
        }

        const result = readAttributeStr(xmlData, i);
        if (result === false) {
          return getErrorObject('InvalidAttr', "Attributes for '"+tagName+"' have open quote.", getLineNumberForPosition(xmlData, i));
        }
        let attrStr = result.value;
        i = result.index;

        if (attrStr[attrStr.length - 1] === '/') {
          //self closing tag
          const attrStrStart = i - attrStr.length;
          attrStr = attrStr.substring(0, attrStr.length - 1);
          const isValid = validateAttributeString(attrStr, options);
          if (isValid === true) {
            tagFound = true;
            //continue; //text may presents after self closing tag
          } else {
            //the result from the nested function returns the position of the error within the attribute
            //in order to get the 'true' error line, we need to calculate the position where the attribute begins (i - attrStr.length) and then add the position within the attribute
            //this gives us the absolute index in the entire xml, which we can use to find the line at last
            return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, attrStrStart + isValid.err.line));
          }
        } else if (closingTag) {
          if (!result.tagClosed) {
            return getErrorObject('InvalidTag', "Closing tag '"+tagName+"' doesn't have proper closing.", getLineNumberForPosition(xmlData, i));
          } else if (attrStr.trim().length > 0) {
            return getErrorObject('InvalidTag', "Closing tag '"+tagName+"' can't have attributes or invalid starting.", getLineNumberForPosition(xmlData, tagStartPos));
          } else if (tags.length === 0) {
            return getErrorObject('InvalidTag', "Closing tag '"+tagName+"' has not been opened.", getLineNumberForPosition(xmlData, tagStartPos));
          } else {
            const otg = tags.pop();
            if (tagName !== otg.tagName) {
              let openPos = getLineNumberForPosition(xmlData, otg.tagStartPos);
              return getErrorObject('InvalidTag',
                "Expected closing tag '"+otg.tagName+"' (opened in line "+openPos.line+", col "+openPos.col+") instead of closing tag '"+tagName+"'.",
                getLineNumberForPosition(xmlData, tagStartPos));
            }

            //when there are no more tags, we reached the root level.
            if (tags.length == 0) {
              reachedRoot = true;
            }
          }
        } else {
          const isValid = validateAttributeString(attrStr, options);
          if (isValid !== true) {
            //the result from the nested function returns the position of the error within the attribute
            //in order to get the 'true' error line, we need to calculate the position where the attribute begins (i - attrStr.length) and then add the position within the attribute
            //this gives us the absolute index in the entire xml, which we can use to find the line at last
            return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, i - attrStr.length + isValid.err.line));
          }

          //if the root level has been reached before ...
          if (reachedRoot === true) {
            return getErrorObject('InvalidXml', 'Multiple possible root nodes found.', getLineNumberForPosition(xmlData, i));
          } else if(options.unpairedTags.indexOf(tagName) !== -1); else {
            tags.push({tagName, tagStartPos});
          }
          tagFound = true;
        }

        //skip tag text value
        //It may include comments and CDATA value
        for (i++; i < xmlData.length; i++) {
          if (xmlData[i] === '<') {
            if (xmlData[i + 1] === '!') {
              //comment or CADATA
              i++;
              i = readCommentAndCDATA(xmlData, i);
              continue;
            } else if (xmlData[i+1] === '?') {
              i = readPI(xmlData, ++i);
              if (i.err) return i;
            } else {
              break;
            }
          } else if (xmlData[i] === '&') {
            const afterAmp = validateAmpersand(xmlData, i);
            if (afterAmp == -1)
              return getErrorObject('InvalidChar', "char '&' is not expected.", getLineNumberForPosition(xmlData, i));
            i = afterAmp;
          }else {
            if (reachedRoot === true && !isWhiteSpace(xmlData[i])) {
              return getErrorObject('InvalidXml', "Extra text at the end", getLineNumberForPosition(xmlData, i));
            }
          }
        } //end of reading tag text value
        if (xmlData[i] === '<') {
          i--;
        }
      }
    } else {
      if ( isWhiteSpace(xmlData[i])) {
        continue;
      }
      return getErrorObject('InvalidChar', "char '"+xmlData[i]+"' is not expected.", getLineNumberForPosition(xmlData, i));
    }
  }

  if (!tagFound) {
    return getErrorObject('InvalidXml', 'Start tag expected.', 1);
  }else if (tags.length == 1) {
      return getErrorObject('InvalidTag', "Unclosed tag '"+tags[0].tagName+"'.", getLineNumberForPosition(xmlData, tags[0].tagStartPos));
  }else if (tags.length > 0) {
      return getErrorObject('InvalidXml', "Invalid '"+
          JSON.stringify(tags.map(t => t.tagName), null, 4).replace(/\r?\n/g, '')+
          "' found.", {line: 1, col: 1});
  }

  return true;
};

function isWhiteSpace(char){
  return char === ' ' || char === '\t' || char === '\n'  || char === '\r';
}
/**
 * Read Processing insstructions and skip
 * @param {*} xmlData
 * @param {*} i
 */
function readPI(xmlData, i) {
  const start = i;
  for (; i < xmlData.length; i++) {
    if (xmlData[i] == '?' || xmlData[i] == ' ') {
      //tagname
      const tagname = xmlData.substr(start, i - start);
      if (i > 5 && tagname === 'xml') {
        return getErrorObject('InvalidXml', 'XML declaration allowed only at the start of the document.', getLineNumberForPosition(xmlData, i));
      } else if (xmlData[i] == '?' && xmlData[i + 1] == '>') {
        //check if valid attribut string
        i++;
        break;
      } else {
        continue;
      }
    }
  }
  return i;
}

function readCommentAndCDATA(xmlData, i) {
  if (xmlData.length > i + 5 && xmlData[i + 1] === '-' && xmlData[i + 2] === '-') {
    //comment
    for (i += 3; i < xmlData.length; i++) {
      if (xmlData[i] === '-' && xmlData[i + 1] === '-' && xmlData[i + 2] === '>') {
        i += 2;
        break;
      }
    }
  } else if (
    xmlData.length > i + 8 &&
    xmlData[i + 1] === 'D' &&
    xmlData[i + 2] === 'O' &&
    xmlData[i + 3] === 'C' &&
    xmlData[i + 4] === 'T' &&
    xmlData[i + 5] === 'Y' &&
    xmlData[i + 6] === 'P' &&
    xmlData[i + 7] === 'E'
  ) {
    let angleBracketsCount = 1;
    for (i += 8; i < xmlData.length; i++) {
      if (xmlData[i] === '<') {
        angleBracketsCount++;
      } else if (xmlData[i] === '>') {
        angleBracketsCount--;
        if (angleBracketsCount === 0) {
          break;
        }
      }
    }
  } else if (
    xmlData.length > i + 9 &&
    xmlData[i + 1] === '[' &&
    xmlData[i + 2] === 'C' &&
    xmlData[i + 3] === 'D' &&
    xmlData[i + 4] === 'A' &&
    xmlData[i + 5] === 'T' &&
    xmlData[i + 6] === 'A' &&
    xmlData[i + 7] === '['
  ) {
    for (i += 8; i < xmlData.length; i++) {
      if (xmlData[i] === ']' && xmlData[i + 1] === ']' && xmlData[i + 2] === '>') {
        i += 2;
        break;
      }
    }
  }

  return i;
}

const doubleQuote = '"';
const singleQuote = "'";

/**
 * Keep reading xmlData until '<' is found outside the attribute value.
 * @param {string} xmlData
 * @param {number} i
 */
function readAttributeStr(xmlData, i) {
  let attrStr = '';
  let startChar = '';
  let tagClosed = false;
  for (; i < xmlData.length; i++) {
    if (xmlData[i] === doubleQuote || xmlData[i] === singleQuote) {
      if (startChar === '') {
        startChar = xmlData[i];
      } else if (startChar !== xmlData[i]) ; else {
        startChar = '';
      }
    } else if (xmlData[i] === '>') {
      if (startChar === '') {
        tagClosed = true;
        break;
      }
    }
    attrStr += xmlData[i];
  }
  if (startChar !== '') {
    return false;
  }

  return {
    value: attrStr,
    index: i,
    tagClosed: tagClosed
  };
}

/**
 * Select all the attributes whether valid or invalid.
 */
const validAttrStrRegxp = new RegExp('(\\s*)([^\\s=]+)(\\s*=)?(\\s*([\'"])(([\\s\\S])*?)\\5)?', 'g');

//attr, ="sd", a="amit's", a="sd"b="saf", ab  cd=""

function validateAttributeString(attrStr, options) {
  //console.log("start:"+attrStr+":end");

  //if(attrStr.trim().length === 0) return true; //empty string

  const matches = util$2.getAllMatches(attrStr, validAttrStrRegxp);
  const attrNames = {};

  for (let i = 0; i < matches.length; i++) {
    if (matches[i][1].length === 0) {
      //nospace before attribute name: a="sd"b="saf"
      return getErrorObject('InvalidAttr', "Attribute '"+matches[i][2]+"' has no space in starting.", getPositionFromMatch(matches[i]))
    } else if (matches[i][3] !== undefined && matches[i][4] === undefined) {
      return getErrorObject('InvalidAttr', "Attribute '"+matches[i][2]+"' is without value.", getPositionFromMatch(matches[i]));
    } else if (matches[i][3] === undefined && !options.allowBooleanAttributes) {
      //independent attribute: ab
      return getErrorObject('InvalidAttr', "boolean attribute '"+matches[i][2]+"' is not allowed.", getPositionFromMatch(matches[i]));
    }
    /* else if(matches[i][6] === undefined){//attribute without value: ab=
                    return { err: { code:"InvalidAttr",msg:"attribute " + matches[i][2] + " has no value assigned."}};
                } */
    const attrName = matches[i][2];
    if (!validateAttrName(attrName)) {
      return getErrorObject('InvalidAttr', "Attribute '"+attrName+"' is an invalid name.", getPositionFromMatch(matches[i]));
    }
    if (!attrNames.hasOwnProperty(attrName)) {
      //check for duplicate attribute.
      attrNames[attrName] = 1;
    } else {
      return getErrorObject('InvalidAttr', "Attribute '"+attrName+"' is repeated.", getPositionFromMatch(matches[i]));
    }
  }

  return true;
}

function validateNumberAmpersand(xmlData, i) {
  let re = /\d/;
  if (xmlData[i] === 'x') {
    i++;
    re = /[\da-fA-F]/;
  }
  for (; i < xmlData.length; i++) {
    if (xmlData[i] === ';')
      return i;
    if (!xmlData[i].match(re))
      break;
  }
  return -1;
}

function validateAmpersand(xmlData, i) {
  // https://www.w3.org/TR/xml/#dt-charref
  i++;
  if (xmlData[i] === ';')
    return -1;
  if (xmlData[i] === '#') {
    i++;
    return validateNumberAmpersand(xmlData, i);
  }
  let count = 0;
  for (; i < xmlData.length; i++, count++) {
    if (xmlData[i].match(/\w/) && count < 20)
      continue;
    if (xmlData[i] === ';')
      break;
    return -1;
  }
  return i;
}

function getErrorObject(code, message, lineNumber) {
  return {
    err: {
      code: code,
      msg: message,
      line: lineNumber.line || lineNumber,
      col: lineNumber.col,
    },
  };
}

function validateAttrName(attrName) {
  return util$2.isName(attrName);
}

// const startsWithXML = /^xml/i;

function validateTagName(tagname) {
  return util$2.isName(tagname) /* && !tagname.match(startsWithXML) */;
}

//this function returns the line number for the character at the given index
function getLineNumberForPosition(xmlData, index) {
  const lines = xmlData.substring(0, index).split(/\r?\n/);
  return {
    line: lines.length,

    // column number is last line's length + 1, because column numbering starts at 1:
    col: lines[lines.length - 1].length + 1
  };
}

//this function returns the position of the first character of match within attrStr
function getPositionFromMatch(match) {
  return match.startIndex + match[1].length;
}

var OptionsBuilder = {};

const defaultOptions$1 = {
    preserveOrder: false,
    attributeNamePrefix: '@_',
    attributesGroupName: false,
    textNodeName: '#text',
    ignoreAttributes: true,
    removeNSPrefix: false, // remove NS from tag name or attribute name if true
    allowBooleanAttributes: false, //a tag can have attributes without any value
    //ignoreRootElement : false,
    parseTagValue: true,
    parseAttributeValue: false,
    trimValues: true, //Trim string values of tag and attributes
    cdataPropName: false,
    numberParseOptions: {
      hex: true,
      leadingZeros: true,
      eNotation: true
    },
    tagValueProcessor: function(tagName, val) {
      return val;
    },
    attributeValueProcessor: function(attrName, val) {
      return val;
    },
    stopNodes: [], //nested tags will not be parsed even for errors
    alwaysCreateTextNode: false,
    isArray: () => false,
    commentPropName: false,
    unpairedTags: [],
    processEntities: true,
    htmlEntities: false,
    ignoreDeclaration: false,
    ignorePiTags: false,
    transformTagName: false,
    transformAttributeName: false,
    updateTag: function(tagName, jPath, attrs){
      return tagName
    },
    // skipEmptyListItem: false
};
   
const buildOptions$1 = function(options) {
    return Object.assign({}, defaultOptions$1, options);
};

OptionsBuilder.buildOptions = buildOptions$1;
OptionsBuilder.defaultOptions = defaultOptions$1;

class XmlNode{
  constructor(tagname) {
    this.tagname = tagname;
    this.child = []; //nested tags, text, cdata, comments in order
    this[":@"] = {}; //attributes map
  }
  add(key,val){
    // this.child.push( {name : key, val: val, isCdata: isCdata });
    if(key === "__proto__") key = "#__proto__";
    this.child.push( {[key]: val });
  }
  addChild(node) {
    if(node.tagname === "__proto__") node.tagname = "#__proto__";
    if(node[":@"] && Object.keys(node[":@"]).length > 0){
      this.child.push( { [node.tagname]: node.child, [":@"]: node[":@"] });
    }else {
      this.child.push( { [node.tagname]: node.child });
    }
  };
}

var xmlNode$1 = XmlNode;

const util$1 = util$3;

//TODO: handle comments
function readDocType$1(xmlData, i){
    
    const entities = {};
    if( xmlData[i + 3] === 'O' &&
         xmlData[i + 4] === 'C' &&
         xmlData[i + 5] === 'T' &&
         xmlData[i + 6] === 'Y' &&
         xmlData[i + 7] === 'P' &&
         xmlData[i + 8] === 'E')
    {    
        i = i+9;
        let angleBracketsCount = 1;
        let hasBody = false, comment = false;
        let exp = "";
        for(;i<xmlData.length;i++){
            if (xmlData[i] === '<' && !comment) { //Determine the tag type
                if( hasBody && isEntity(xmlData, i)){
                    i += 7; 
                    [entityName, val,i] = readEntityExp(xmlData,i+1);
                    if(val.indexOf("&") === -1) //Parameter entities are not supported
                        entities[ validateEntityName(entityName) ] = {
                            regx : RegExp( `&${entityName};`,"g"),
                            val: val
                        };
                }
                else if( hasBody && isElement(xmlData, i))  i += 8;//Not supported
                else if( hasBody && isAttlist(xmlData, i))  i += 8;//Not supported
                else if( hasBody && isNotation(xmlData, i)) i += 9;//Not supported
                else if( isComment)                         comment = true;
                else                                        throw new Error("Invalid DOCTYPE");

                angleBracketsCount++;
                exp = "";
            } else if (xmlData[i] === '>') { //Read tag content
                if(comment){
                    if( xmlData[i - 1] === "-" && xmlData[i - 2] === "-"){
                        comment = false;
                        angleBracketsCount--;
                    }
                }else {
                    angleBracketsCount--;
                }
                if (angleBracketsCount === 0) {
                  break;
                }
            }else if( xmlData[i] === '['){
                hasBody = true;
            }else {
                exp += xmlData[i];
            }
        }
        if(angleBracketsCount !== 0){
            throw new Error(`Unclosed DOCTYPE`);
        }
    }else {
        throw new Error(`Invalid Tag instead of DOCTYPE`);
    }
    return {entities, i};
}

function readEntityExp(xmlData,i){
    //External entities are not supported
    //    <!ENTITY ext SYSTEM "http://normal-website.com" >

    //Parameter entities are not supported
    //    <!ENTITY entityname "&anotherElement;">

    //Internal entities are supported
    //    <!ENTITY entityname "replacement text">
    
    //read EntityName
    let entityName = "";
    for (; i < xmlData.length && (xmlData[i] !== "'" && xmlData[i] !== '"' ); i++) {
        // if(xmlData[i] === " ") continue;
        // else 
        entityName += xmlData[i];
    }
    entityName = entityName.trim();
    if(entityName.indexOf(" ") !== -1) throw new Error("External entites are not supported");

    //read Entity Value
    const startChar = xmlData[i++];
    let val = "";
    for (; i < xmlData.length && xmlData[i] !== startChar ; i++) {
        val += xmlData[i];
    }
    return [entityName, val, i];
}

function isComment(xmlData, i){
    if(xmlData[i+1] === '!' &&
    xmlData[i+2] === '-' &&
    xmlData[i+3] === '-') return true
    return false
}
function isEntity(xmlData, i){
    if(xmlData[i+1] === '!' &&
    xmlData[i+2] === 'E' &&
    xmlData[i+3] === 'N' &&
    xmlData[i+4] === 'T' &&
    xmlData[i+5] === 'I' &&
    xmlData[i+6] === 'T' &&
    xmlData[i+7] === 'Y') return true
    return false
}
function isElement(xmlData, i){
    if(xmlData[i+1] === '!' &&
    xmlData[i+2] === 'E' &&
    xmlData[i+3] === 'L' &&
    xmlData[i+4] === 'E' &&
    xmlData[i+5] === 'M' &&
    xmlData[i+6] === 'E' &&
    xmlData[i+7] === 'N' &&
    xmlData[i+8] === 'T') return true
    return false
}

function isAttlist(xmlData, i){
    if(xmlData[i+1] === '!' &&
    xmlData[i+2] === 'A' &&
    xmlData[i+3] === 'T' &&
    xmlData[i+4] === 'T' &&
    xmlData[i+5] === 'L' &&
    xmlData[i+6] === 'I' &&
    xmlData[i+7] === 'S' &&
    xmlData[i+8] === 'T') return true
    return false
}
function isNotation(xmlData, i){
    if(xmlData[i+1] === '!' &&
    xmlData[i+2] === 'N' &&
    xmlData[i+3] === 'O' &&
    xmlData[i+4] === 'T' &&
    xmlData[i+5] === 'A' &&
    xmlData[i+6] === 'T' &&
    xmlData[i+7] === 'I' &&
    xmlData[i+8] === 'O' &&
    xmlData[i+9] === 'N') return true
    return false
}

function validateEntityName(name){
    if (util$1.isName(name))
	return name;
    else
        throw new Error(`Invalid entity name ${name}`);
}

var DocTypeReader = readDocType$1;

const hexRegex = /^[-+]?0x[a-fA-F0-9]+$/;
const numRegex = /^([\-\+])?(0*)(\.[0-9]+([eE]\-?[0-9]+)?|[0-9]+(\.[0-9]+([eE]\-?[0-9]+)?)?)$/;
// const octRegex = /0x[a-z0-9]+/;
// const binRegex = /0x[a-z0-9]+/;


//polyfill
if (!Number.parseInt && window.parseInt) {
    Number.parseInt = window.parseInt;
}
if (!Number.parseFloat && window.parseFloat) {
    Number.parseFloat = window.parseFloat;
}

  
const consider = {
    hex :  true,
    leadingZeros: true,
    decimalPoint: "\.",
    eNotation: true
    //skipLike: /regex/
};

function toNumber$1(str, options = {}){
    // const options = Object.assign({}, consider);
    // if(opt.leadingZeros === false){
    //     options.leadingZeros = false;
    // }else if(opt.hex === false){
    //     options.hex = false;
    // }

    options = Object.assign({}, consider, options );
    if(!str || typeof str !== "string" ) return str;
    
    let trimmedStr  = str.trim();
    // if(trimmedStr === "0.0") return 0;
    // else if(trimmedStr === "+0.0") return 0;
    // else if(trimmedStr === "-0.0") return -0;

    if(options.skipLike !== undefined && options.skipLike.test(trimmedStr)) return str;
    else if (options.hex && hexRegex.test(trimmedStr)) {
        return Number.parseInt(trimmedStr, 16);
    // } else if (options.parseOct && octRegex.test(str)) {
    //     return Number.parseInt(val, 8);
    // }else if (options.parseBin && binRegex.test(str)) {
    //     return Number.parseInt(val, 2);
    }else {
        //separate negative sign, leading zeros, and rest number
        const match = numRegex.exec(trimmedStr);
        if(match){
            const sign = match[1];
            const leadingZeros = match[2];
            let numTrimmedByZeros = trimZeros(match[3]); //complete num without leading zeros
            //trim ending zeros for floating number
            
            const eNotation = match[4] || match[6];
            if(!options.leadingZeros && leadingZeros.length > 0 && sign && trimmedStr[2] !== ".") return str; //-0123
            else if(!options.leadingZeros && leadingZeros.length > 0 && !sign && trimmedStr[1] !== ".") return str; //0123
            else {//no leading zeros or leading zeros are allowed
                const num = Number(trimmedStr);
                const numStr = "" + num;
                if(numStr.search(/[eE]/) !== -1){ //given number is long and parsed to eNotation
                    if(options.eNotation) return num;
                    else return str;
                }else if(eNotation){ //given number has enotation
                    if(options.eNotation) return num;
                    else return str;
                }else if(trimmedStr.indexOf(".") !== -1){ //floating number
                    // const decimalPart = match[5].substr(1);
                    // const intPart = trimmedStr.substr(0,trimmedStr.indexOf("."));

                    
                    // const p = numStr.indexOf(".");
                    // const givenIntPart = numStr.substr(0,p);
                    // const givenDecPart = numStr.substr(p+1);
                    if(numStr === "0" && (numTrimmedByZeros === "") ) return num; //0.0
                    else if(numStr === numTrimmedByZeros) return num; //0.456. 0.79000
                    else if( sign && numStr === "-"+numTrimmedByZeros) return num;
                    else return str;
                }
                
                if(leadingZeros){
                    // if(numTrimmedByZeros === numStr){
                    //     if(options.leadingZeros) return num;
                    //     else return str;
                    // }else return str;
                    if(numTrimmedByZeros === numStr) return num;
                    else if(sign+numTrimmedByZeros === numStr) return num;
                    else return str;
                }

                if(trimmedStr === numStr) return num;
                else if(trimmedStr === sign+numStr) return num;
                // else{
                //     //number with +/- sign
                //     trimmedStr.test(/[-+][0-9]);

                // }
                return str;
            }
            // else if(!eNotation && trimmedStr && trimmedStr !== Number(trimmedStr) ) return str;
            
        }else { //non-numeric string
            return str;
        }
    }
}

/**
 * 
 * @param {string} numStr without leading zeros
 * @returns 
 */
function trimZeros(numStr){
    if(numStr && numStr.indexOf(".") !== -1){//float
        numStr = numStr.replace(/0+$/, ""); //remove ending zeros
        if(numStr === ".")  numStr = "0";
        else if(numStr[0] === ".")  numStr = "0"+numStr;
        else if(numStr[numStr.length-1] === ".")  numStr = numStr.substr(0,numStr.length-1);
        return numStr;
    }
    return numStr;
}
var strnum = toNumber$1;

///@ts-check

const util = util$3;
const xmlNode = xmlNode$1;
const readDocType = DocTypeReader;
const toNumber = strnum;

// const regx =
//   '<((!\\[CDATA\\[([\\s\\S]*?)(]]>))|((NAME:)?(NAME))([^>]*)>|((\\/)(NAME)\\s*>))([^<]*)'
//   .replace(/NAME/g, util.nameRegexp);

//const tagsRegx = new RegExp("<(\\/?[\\w:\\-\._]+)([^>]*)>(\\s*"+cdataRegx+")*([^<]+)?","g");
//const tagsRegx = new RegExp("<(\\/?)((\\w*:)?([\\w:\\-\._]+))([^>]*)>([^<]*)("+cdataRegx+"([^<]*))*([^<]+)?","g");

class OrderedObjParser$1{
  constructor(options){
    this.options = options;
    this.currentNode = null;
    this.tagsNodeStack = [];
    this.docTypeEntities = {};
    this.lastEntities = {
      "apos" : { regex: /&(apos|#39|#x27);/g, val : "'"},
      "gt" : { regex: /&(gt|#62|#x3E);/g, val : ">"},
      "lt" : { regex: /&(lt|#60|#x3C);/g, val : "<"},
      "quot" : { regex: /&(quot|#34|#x22);/g, val : "\""},
    };
    this.ampEntity = { regex: /&(amp|#38|#x26);/g, val : "&"};
    this.htmlEntities = {
      "space": { regex: /&(nbsp|#160);/g, val: " " },
      // "lt" : { regex: /&(lt|#60);/g, val: "<" },
      // "gt" : { regex: /&(gt|#62);/g, val: ">" },
      // "amp" : { regex: /&(amp|#38);/g, val: "&" },
      // "quot" : { regex: /&(quot|#34);/g, val: "\"" },
      // "apos" : { regex: /&(apos|#39);/g, val: "'" },
      "cent" : { regex: /&(cent|#162);/g, val: "¢" },
      "pound" : { regex: /&(pound|#163);/g, val: "£" },
      "yen" : { regex: /&(yen|#165);/g, val: "¥" },
      "euro" : { regex: /&(euro|#8364);/g, val: "€" },
      "copyright" : { regex: /&(copy|#169);/g, val: "©" },
      "reg" : { regex: /&(reg|#174);/g, val: "®" },
      "inr" : { regex: /&(inr|#8377);/g, val: "₹" },
      "num_dec": { regex: /&#([0-9]{1,7});/g, val : (_, str) => String.fromCharCode(Number.parseInt(str, 10)) },
      "num_hex": { regex: /&#x([0-9a-fA-F]{1,6});/g, val : (_, str) => String.fromCharCode(Number.parseInt(str, 16)) },
    };
    this.addExternalEntities = addExternalEntities;
    this.parseXml = parseXml;
    this.parseTextData = parseTextData;
    this.resolveNameSpace = resolveNameSpace;
    this.buildAttributesMap = buildAttributesMap;
    this.isItStopNode = isItStopNode;
    this.replaceEntitiesValue = replaceEntitiesValue$1;
    this.readStopNodeData = readStopNodeData;
    this.saveTextToParentTag = saveTextToParentTag;
    this.addChild = addChild;
  }

}

function addExternalEntities(externalEntities){
  const entKeys = Object.keys(externalEntities);
  for (let i = 0; i < entKeys.length; i++) {
    const ent = entKeys[i];
    this.lastEntities[ent] = {
       regex: new RegExp("&"+ent+";","g"),
       val : externalEntities[ent]
    };
  }
}

/**
 * @param {string} val
 * @param {string} tagName
 * @param {string} jPath
 * @param {boolean} dontTrim
 * @param {boolean} hasAttributes
 * @param {boolean} isLeafNode
 * @param {boolean} escapeEntities
 */
function parseTextData(val, tagName, jPath, dontTrim, hasAttributes, isLeafNode, escapeEntities) {
  if (val !== undefined) {
    if (this.options.trimValues && !dontTrim) {
      val = val.trim();
    }
    if(val.length > 0){
      if(!escapeEntities) val = this.replaceEntitiesValue(val);
      
      const newval = this.options.tagValueProcessor(tagName, val, jPath, hasAttributes, isLeafNode);
      if(newval === null || newval === undefined){
        //don't parse
        return val;
      }else if(typeof newval !== typeof val || newval !== val){
        //overwrite
        return newval;
      }else if(this.options.trimValues){
        return parseValue(val, this.options.parseTagValue, this.options.numberParseOptions);
      }else {
        const trimmedVal = val.trim();
        if(trimmedVal === val){
          return parseValue(val, this.options.parseTagValue, this.options.numberParseOptions);
        }else {
          return val;
        }
      }
    }
  }
}

function resolveNameSpace(tagname) {
  if (this.options.removeNSPrefix) {
    const tags = tagname.split(':');
    const prefix = tagname.charAt(0) === '/' ? '/' : '';
    if (tags[0] === 'xmlns') {
      return '';
    }
    if (tags.length === 2) {
      tagname = prefix + tags[1];
    }
  }
  return tagname;
}

//TODO: change regex to capture NS
//const attrsRegx = new RegExp("([\\w\\-\\.\\:]+)\\s*=\\s*(['\"])((.|\n)*?)\\2","gm");
const attrsRegx = new RegExp('([^\\s=]+)\\s*(=\\s*([\'"])([\\s\\S]*?)\\3)?', 'gm');

function buildAttributesMap(attrStr, jPath, tagName) {
  if (!this.options.ignoreAttributes && typeof attrStr === 'string') {
    // attrStr = attrStr.replace(/\r?\n/g, ' ');
    //attrStr = attrStr || attrStr.trim();

    const matches = util.getAllMatches(attrStr, attrsRegx);
    const len = matches.length; //don't make it inline
    const attrs = {};
    for (let i = 0; i < len; i++) {
      const attrName = this.resolveNameSpace(matches[i][1]);
      let oldVal = matches[i][4];
      let aName = this.options.attributeNamePrefix + attrName;
      if (attrName.length) {
        if (this.options.transformAttributeName) {
          aName = this.options.transformAttributeName(aName);
        }
        if(aName === "__proto__") aName  = "#__proto__";
        if (oldVal !== undefined) {
          if (this.options.trimValues) {
            oldVal = oldVal.trim();
          }
          oldVal = this.replaceEntitiesValue(oldVal);
          const newVal = this.options.attributeValueProcessor(attrName, oldVal, jPath);
          if(newVal === null || newVal === undefined){
            //don't parse
            attrs[aName] = oldVal;
          }else if(typeof newVal !== typeof oldVal || newVal !== oldVal){
            //overwrite
            attrs[aName] = newVal;
          }else {
            //parse
            attrs[aName] = parseValue(
              oldVal,
              this.options.parseAttributeValue,
              this.options.numberParseOptions
            );
          }
        } else if (this.options.allowBooleanAttributes) {
          attrs[aName] = true;
        }
      }
    }
    if (!Object.keys(attrs).length) {
      return;
    }
    if (this.options.attributesGroupName) {
      const attrCollection = {};
      attrCollection[this.options.attributesGroupName] = attrs;
      return attrCollection;
    }
    return attrs
  }
}

const parseXml = function(xmlData) {
  xmlData = xmlData.replace(/\r\n?/g, "\n"); //TODO: remove this line
  const xmlObj = new xmlNode('!xml');
  let currentNode = xmlObj;
  let textData = "";
  let jPath = "";
  for(let i=0; i< xmlData.length; i++){//for each char in XML data
    const ch = xmlData[i];
    if(ch === '<'){
      // const nextIndex = i+1;
      // const _2ndChar = xmlData[nextIndex];
      if( xmlData[i+1] === '/') {//Closing Tag
        const closeIndex = findClosingIndex(xmlData, ">", i, "Closing Tag is not closed.");
        let tagName = xmlData.substring(i+2,closeIndex).trim();

        if(this.options.removeNSPrefix){
          const colonIndex = tagName.indexOf(":");
          if(colonIndex !== -1){
            tagName = tagName.substr(colonIndex+1);
          }
        }

        if(this.options.transformTagName) {
          tagName = this.options.transformTagName(tagName);
        }

        if(currentNode){
          textData = this.saveTextToParentTag(textData, currentNode, jPath);
        }

        //check if last tag of nested tag was unpaired tag
        const lastTagName = jPath.substring(jPath.lastIndexOf(".")+1);
        if(tagName && this.options.unpairedTags.indexOf(tagName) !== -1 ){
          throw new Error(`Unpaired tag can not be used as closing tag: </${tagName}>`);
        }
        let propIndex = 0;
        if(lastTagName && this.options.unpairedTags.indexOf(lastTagName) !== -1 ){
          propIndex = jPath.lastIndexOf('.', jPath.lastIndexOf('.')-1);
          this.tagsNodeStack.pop();
        }else {
          propIndex = jPath.lastIndexOf(".");
        }
        jPath = jPath.substring(0, propIndex);

        currentNode = this.tagsNodeStack.pop();//avoid recursion, set the parent tag scope
        textData = "";
        i = closeIndex;
      } else if( xmlData[i+1] === '?') {

        let tagData = readTagExp(xmlData,i, false, "?>");
        if(!tagData) throw new Error("Pi Tag is not closed.");

        textData = this.saveTextToParentTag(textData, currentNode, jPath);
        if( (this.options.ignoreDeclaration && tagData.tagName === "?xml") || this.options.ignorePiTags);else {
  
          const childNode = new xmlNode(tagData.tagName);
          childNode.add(this.options.textNodeName, "");
          
          if(tagData.tagName !== tagData.tagExp && tagData.attrExpPresent){
            childNode[":@"] = this.buildAttributesMap(tagData.tagExp, jPath, tagData.tagName);
          }
          this.addChild(currentNode, childNode, jPath);

        }


        i = tagData.closeIndex + 1;
      } else if(xmlData.substr(i + 1, 3) === '!--') {
        const endIndex = findClosingIndex(xmlData, "-->", i+4, "Comment is not closed.");
        if(this.options.commentPropName){
          const comment = xmlData.substring(i + 4, endIndex - 2);

          textData = this.saveTextToParentTag(textData, currentNode, jPath);

          currentNode.add(this.options.commentPropName, [ { [this.options.textNodeName] : comment } ]);
        }
        i = endIndex;
      } else if( xmlData.substr(i + 1, 2) === '!D') {
        const result = readDocType(xmlData, i);
        this.docTypeEntities = result.entities;
        i = result.i;
      }else if(xmlData.substr(i + 1, 2) === '![') {
        const closeIndex = findClosingIndex(xmlData, "]]>", i, "CDATA is not closed.") - 2;
        const tagExp = xmlData.substring(i + 9,closeIndex);

        textData = this.saveTextToParentTag(textData, currentNode, jPath);

        let val = this.parseTextData(tagExp, currentNode.tagname, jPath, true, false, true, true);
        if(val == undefined) val = "";

        //cdata should be set even if it is 0 length string
        if(this.options.cdataPropName){
          currentNode.add(this.options.cdataPropName, [ { [this.options.textNodeName] : tagExp } ]);
        }else {
          currentNode.add(this.options.textNodeName, val);
        }
        
        i = closeIndex + 2;
      }else {//Opening tag
        let result = readTagExp(xmlData,i, this.options.removeNSPrefix);
        let tagName= result.tagName;
        const rawTagName = result.rawTagName;
        let tagExp = result.tagExp;
        let attrExpPresent = result.attrExpPresent;
        let closeIndex = result.closeIndex;

        if (this.options.transformTagName) {
          tagName = this.options.transformTagName(tagName);
        }
        
        //save text as child node
        if (currentNode && textData) {
          if(currentNode.tagname !== '!xml'){
            //when nested tag is found
            textData = this.saveTextToParentTag(textData, currentNode, jPath, false);
          }
        }

        //check if last tag was unpaired tag
        const lastTag = currentNode;
        if(lastTag && this.options.unpairedTags.indexOf(lastTag.tagname) !== -1 ){
          currentNode = this.tagsNodeStack.pop();
          jPath = jPath.substring(0, jPath.lastIndexOf("."));
        }
        if(tagName !== xmlObj.tagname){
          jPath += jPath ? "." + tagName : tagName;
        }
        if (this.isItStopNode(this.options.stopNodes, jPath, tagName)) {
          let tagContent = "";
          //self-closing tag
          if(tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1){
            if(tagName[tagName.length - 1] === "/"){ //remove trailing '/'
              tagName = tagName.substr(0, tagName.length - 1);
              jPath = jPath.substr(0, jPath.length - 1);
              tagExp = tagName;
            }else {
              tagExp = tagExp.substr(0, tagExp.length - 1);
            }
            i = result.closeIndex;
          }
          //unpaired tag
          else if(this.options.unpairedTags.indexOf(tagName) !== -1){
            
            i = result.closeIndex;
          }
          //normal tag
          else {
            //read until closing tag is found
            const result = this.readStopNodeData(xmlData, rawTagName, closeIndex + 1);
            if(!result) throw new Error(`Unexpected end of ${rawTagName}`);
            i = result.i;
            tagContent = result.tagContent;
          }

          const childNode = new xmlNode(tagName);
          if(tagName !== tagExp && attrExpPresent){
            childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
          }
          if(tagContent) {
            tagContent = this.parseTextData(tagContent, tagName, jPath, true, attrExpPresent, true, true);
          }
          
          jPath = jPath.substr(0, jPath.lastIndexOf("."));
          childNode.add(this.options.textNodeName, tagContent);
          
          this.addChild(currentNode, childNode, jPath);
        }else {
  //selfClosing tag
          if(tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1){
            if(tagName[tagName.length - 1] === "/"){ //remove trailing '/'
              tagName = tagName.substr(0, tagName.length - 1);
              jPath = jPath.substr(0, jPath.length - 1);
              tagExp = tagName;
            }else {
              tagExp = tagExp.substr(0, tagExp.length - 1);
            }
            
            if(this.options.transformTagName) {
              tagName = this.options.transformTagName(tagName);
            }

            const childNode = new xmlNode(tagName);
            if(tagName !== tagExp && attrExpPresent){
              childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
            }
            this.addChild(currentNode, childNode, jPath);
            jPath = jPath.substr(0, jPath.lastIndexOf("."));
          }
    //opening tag
          else {
            const childNode = new xmlNode( tagName);
            this.tagsNodeStack.push(currentNode);
            
            if(tagName !== tagExp && attrExpPresent){
              childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
            }
            this.addChild(currentNode, childNode, jPath);
            currentNode = childNode;
          }
          textData = "";
          i = closeIndex;
        }
      }
    }else {
      textData += xmlData[i];
    }
  }
  return xmlObj.child;
};

function addChild(currentNode, childNode, jPath){
  const result = this.options.updateTag(childNode.tagname, jPath, childNode[":@"]);
  if(result === false);else if(typeof result === "string"){
    childNode.tagname = result;
    currentNode.addChild(childNode);
  }else {
    currentNode.addChild(childNode);
  }
}

const replaceEntitiesValue$1 = function(val){

  if(this.options.processEntities){
    for(let entityName in this.docTypeEntities){
      const entity = this.docTypeEntities[entityName];
      val = val.replace( entity.regx, entity.val);
    }
    for(let entityName in this.lastEntities){
      const entity = this.lastEntities[entityName];
      val = val.replace( entity.regex, entity.val);
    }
    if(this.options.htmlEntities){
      for(let entityName in this.htmlEntities){
        const entity = this.htmlEntities[entityName];
        val = val.replace( entity.regex, entity.val);
      }
    }
    val = val.replace( this.ampEntity.regex, this.ampEntity.val);
  }
  return val;
};
function saveTextToParentTag(textData, currentNode, jPath, isLeafNode) {
  if (textData) { //store previously collected data as textNode
    if(isLeafNode === undefined) isLeafNode = Object.keys(currentNode.child).length === 0;
    
    textData = this.parseTextData(textData,
      currentNode.tagname,
      jPath,
      false,
      currentNode[":@"] ? Object.keys(currentNode[":@"]).length !== 0 : false,
      isLeafNode);

    if (textData !== undefined && textData !== "")
      currentNode.add(this.options.textNodeName, textData);
    textData = "";
  }
  return textData;
}

//TODO: use jPath to simplify the logic
/**
 * 
 * @param {string[]} stopNodes 
 * @param {string} jPath
 * @param {string} currentTagName 
 */
function isItStopNode(stopNodes, jPath, currentTagName){
  const allNodesExp = "*." + currentTagName;
  for (const stopNodePath in stopNodes) {
    const stopNodeExp = stopNodes[stopNodePath];
    if( allNodesExp === stopNodeExp || jPath === stopNodeExp  ) return true;
  }
  return false;
}

/**
 * Returns the tag Expression and where it is ending handling single-double quotes situation
 * @param {string} xmlData 
 * @param {number} i starting index
 * @returns 
 */
function tagExpWithClosingIndex(xmlData, i, closingChar = ">"){
  let attrBoundary;
  let tagExp = "";
  for (let index = i; index < xmlData.length; index++) {
    let ch = xmlData[index];
    if (attrBoundary) {
        if (ch === attrBoundary) attrBoundary = "";//reset
    } else if (ch === '"' || ch === "'") {
        attrBoundary = ch;
    } else if (ch === closingChar[0]) {
      if(closingChar[1]){
        if(xmlData[index + 1] === closingChar[1]){
          return {
            data: tagExp,
            index: index
          }
        }
      }else {
        return {
          data: tagExp,
          index: index
        }
      }
    } else if (ch === '\t') {
      ch = " ";
    }
    tagExp += ch;
  }
}

function findClosingIndex(xmlData, str, i, errMsg){
  const closingIndex = xmlData.indexOf(str, i);
  if(closingIndex === -1){
    throw new Error(errMsg)
  }else {
    return closingIndex + str.length - 1;
  }
}

function readTagExp(xmlData,i, removeNSPrefix, closingChar = ">"){
  const result = tagExpWithClosingIndex(xmlData, i+1, closingChar);
  if(!result) return;
  let tagExp = result.data;
  const closeIndex = result.index;
  const separatorIndex = tagExp.search(/\s/);
  let tagName = tagExp;
  let attrExpPresent = true;
  if(separatorIndex !== -1){//separate tag name and attributes expression
    tagName = tagExp.substring(0, separatorIndex);
    tagExp = tagExp.substring(separatorIndex + 1).trimStart();
  }

  const rawTagName = tagName;
  if(removeNSPrefix){
    const colonIndex = tagName.indexOf(":");
    if(colonIndex !== -1){
      tagName = tagName.substr(colonIndex+1);
      attrExpPresent = tagName !== result.data.substr(colonIndex + 1);
    }
  }

  return {
    tagName: tagName,
    tagExp: tagExp,
    closeIndex: closeIndex,
    attrExpPresent: attrExpPresent,
    rawTagName: rawTagName,
  }
}
/**
 * find paired tag for a stop node
 * @param {string} xmlData 
 * @param {string} tagName 
 * @param {number} i 
 */
function readStopNodeData(xmlData, tagName, i){
  const startIndex = i;
  // Starting at 1 since we already have an open tag
  let openTagCount = 1;

  for (; i < xmlData.length; i++) {
    if( xmlData[i] === "<"){ 
      if (xmlData[i+1] === "/") {//close tag
          const closeIndex = findClosingIndex(xmlData, ">", i, `${tagName} is not closed`);
          let closeTagName = xmlData.substring(i+2,closeIndex).trim();
          if(closeTagName === tagName){
            openTagCount--;
            if (openTagCount === 0) {
              return {
                tagContent: xmlData.substring(startIndex, i),
                i : closeIndex
              }
            }
          }
          i=closeIndex;
        } else if(xmlData[i+1] === '?') { 
          const closeIndex = findClosingIndex(xmlData, "?>", i+1, "StopNode is not closed.");
          i=closeIndex;
        } else if(xmlData.substr(i + 1, 3) === '!--') { 
          const closeIndex = findClosingIndex(xmlData, "-->", i+3, "StopNode is not closed.");
          i=closeIndex;
        } else if(xmlData.substr(i + 1, 2) === '![') { 
          const closeIndex = findClosingIndex(xmlData, "]]>", i, "StopNode is not closed.") - 2;
          i=closeIndex;
        } else {
          const tagData = readTagExp(xmlData, i, '>');

          if (tagData) {
            const openTagName = tagData && tagData.tagName;
            if (openTagName === tagName && tagData.tagExp[tagData.tagExp.length-1] !== "/") {
              openTagCount++;
            }
            i=tagData.closeIndex;
          }
        }
      }
  }//end for loop
}

function parseValue(val, shouldParse, options) {
  if (shouldParse && typeof val === 'string') {
    //console.log(options)
    const newval = val.trim();
    if(newval === 'true' ) return true;
    else if(newval === 'false' ) return false;
    else return toNumber(val, options);
  } else {
    if (util.isExist(val)) {
      return val;
    } else {
      return '';
    }
  }
}


var OrderedObjParser_1 = OrderedObjParser$1;

var node2json = {};

/**
 * 
 * @param {array} node 
 * @param {any} options 
 * @returns 
 */
function prettify$1(node, options){
  return compress( node, options);
}

/**
 * 
 * @param {array} arr 
 * @param {object} options 
 * @param {string} jPath 
 * @returns object
 */
function compress(arr, options, jPath){
  let text;
  const compressedObj = {};
  for (let i = 0; i < arr.length; i++) {
    const tagObj = arr[i];
    const property = propName$1(tagObj);
    let newJpath = "";
    if(jPath === undefined) newJpath = property;
    else newJpath = jPath + "." + property;

    if(property === options.textNodeName){
      if(text === undefined) text = tagObj[property];
      else text += "" + tagObj[property];
    }else if(property === undefined){
      continue;
    }else if(tagObj[property]){
      
      let val = compress(tagObj[property], options, newJpath);
      const isLeaf = isLeafTag(val, options);

      if(tagObj[":@"]){
        assignAttributes( val, tagObj[":@"], newJpath, options);
      }else if(Object.keys(val).length === 1 && val[options.textNodeName] !== undefined && !options.alwaysCreateTextNode){
        val = val[options.textNodeName];
      }else if(Object.keys(val).length === 0){
        if(options.alwaysCreateTextNode) val[options.textNodeName] = "";
        else val = "";
      }

      if(compressedObj[property] !== undefined && compressedObj.hasOwnProperty(property)) {
        if(!Array.isArray(compressedObj[property])) {
            compressedObj[property] = [ compressedObj[property] ];
        }
        compressedObj[property].push(val);
      }else {
        //TODO: if a node is not an array, then check if it should be an array
        //also determine if it is a leaf node
        if (options.isArray(property, newJpath, isLeaf )) {
          compressedObj[property] = [val];
        }else {
          compressedObj[property] = val;
        }
      }
    }
    
  }
  // if(text && text.length > 0) compressedObj[options.textNodeName] = text;
  if(typeof text === "string"){
    if(text.length > 0) compressedObj[options.textNodeName] = text;
  }else if(text !== undefined) compressedObj[options.textNodeName] = text;
  return compressedObj;
}

function propName$1(obj){
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if(key !== ":@") return key;
  }
}

function assignAttributes(obj, attrMap, jpath, options){
  if (attrMap) {
    const keys = Object.keys(attrMap);
    const len = keys.length; //don't make it inline
    for (let i = 0; i < len; i++) {
      const atrrName = keys[i];
      if (options.isArray(atrrName, jpath + "." + atrrName, true, true)) {
        obj[atrrName] = [ attrMap[atrrName] ];
      } else {
        obj[atrrName] = attrMap[atrrName];
      }
    }
  }
}

function isLeafTag(obj, options){
  const { textNodeName } = options;
  const propCount = Object.keys(obj).length;
  
  if (propCount === 0) {
    return true;
  }

  if (
    propCount === 1 &&
    (obj[textNodeName] || typeof obj[textNodeName] === "boolean" || obj[textNodeName] === 0)
  ) {
    return true;
  }

  return false;
}
node2json.prettify = prettify$1;

const { buildOptions} = OptionsBuilder;
const OrderedObjParser = OrderedObjParser_1;
const { prettify} = node2json;
const validator$1 = validator$2;

class XMLParser$1{
    
    constructor(options){
        this.externalEntities = {};
        this.options = buildOptions(options);
        
    }
    /**
     * Parse XML dats to JS object 
     * @param {string|Buffer} xmlData 
     * @param {boolean|Object} validationOption 
     */
    parse(xmlData,validationOption){
        if(typeof xmlData === "string");else if( xmlData.toString){
            xmlData = xmlData.toString();
        }else {
            throw new Error("XML data is accepted in String or Bytes[] form.")
        }
        if( validationOption){
            if(validationOption === true) validationOption = {}; //validate with default options
            
            const result = validator$1.validate(xmlData, validationOption);
            if (result !== true) {
              throw Error( `${result.err.msg}:${result.err.line}:${result.err.col}` )
            }
          }
        const orderedObjParser = new OrderedObjParser(this.options);
        orderedObjParser.addExternalEntities(this.externalEntities);
        const orderedResult = orderedObjParser.parseXml(xmlData);
        if(this.options.preserveOrder || orderedResult === undefined) return orderedResult;
        else return prettify(orderedResult, this.options);
    }

    /**
     * Add Entity which is not by default supported by this library
     * @param {string} key 
     * @param {string} value 
     */
    addEntity(key, value){
        if(value.indexOf("&") !== -1){
            throw new Error("Entity value can't have '&'")
        }else if(key.indexOf("&") !== -1 || key.indexOf(";") !== -1){
            throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'")
        }else if(value === "&"){
            throw new Error("An entity with value '&' is not permitted");
        }else {
            this.externalEntities[key] = value;
        }
    }
}

var XMLParser_1 = XMLParser$1;

const EOL = "\n";

/**
 * 
 * @param {array} jArray 
 * @param {any} options 
 * @returns 
 */
function toXml(jArray, options) {
    let indentation = "";
    if (options.format && options.indentBy.length > 0) {
        indentation = EOL;
    }
    return arrToStr(jArray, options, "", indentation);
}

function arrToStr(arr, options, jPath, indentation) {
    let xmlStr = "";
    let isPreviousElementTag = false;

    for (let i = 0; i < arr.length; i++) {
        const tagObj = arr[i];
        const tagName = propName(tagObj);
        if(tagName === undefined) continue;

        let newJPath = "";
        if (jPath.length === 0) newJPath = tagName;
        else newJPath = `${jPath}.${tagName}`;

        if (tagName === options.textNodeName) {
            let tagText = tagObj[tagName];
            if (!isStopNode(newJPath, options)) {
                tagText = options.tagValueProcessor(tagName, tagText);
                tagText = replaceEntitiesValue(tagText, options);
            }
            if (isPreviousElementTag) {
                xmlStr += indentation;
            }
            xmlStr += tagText;
            isPreviousElementTag = false;
            continue;
        } else if (tagName === options.cdataPropName) {
            if (isPreviousElementTag) {
                xmlStr += indentation;
            }
            xmlStr += `<![CDATA[${tagObj[tagName][0][options.textNodeName]}]]>`;
            isPreviousElementTag = false;
            continue;
        } else if (tagName === options.commentPropName) {
            xmlStr += indentation + `<!--${tagObj[tagName][0][options.textNodeName]}-->`;
            isPreviousElementTag = true;
            continue;
        } else if (tagName[0] === "?") {
            const attStr = attr_to_str(tagObj[":@"], options);
            const tempInd = tagName === "?xml" ? "" : indentation;
            let piTextNodeName = tagObj[tagName][0][options.textNodeName];
            piTextNodeName = piTextNodeName.length !== 0 ? " " + piTextNodeName : ""; //remove extra spacing
            xmlStr += tempInd + `<${tagName}${piTextNodeName}${attStr}?>`;
            isPreviousElementTag = true;
            continue;
        }
        let newIdentation = indentation;
        if (newIdentation !== "") {
            newIdentation += options.indentBy;
        }
        const attStr = attr_to_str(tagObj[":@"], options);
        const tagStart = indentation + `<${tagName}${attStr}`;
        const tagValue = arrToStr(tagObj[tagName], options, newJPath, newIdentation);
        if (options.unpairedTags.indexOf(tagName) !== -1) {
            if (options.suppressUnpairedNode) xmlStr += tagStart + ">";
            else xmlStr += tagStart + "/>";
        } else if ((!tagValue || tagValue.length === 0) && options.suppressEmptyNode) {
            xmlStr += tagStart + "/>";
        } else if (tagValue && tagValue.endsWith(">")) {
            xmlStr += tagStart + `>${tagValue}${indentation}</${tagName}>`;
        } else {
            xmlStr += tagStart + ">";
            if (tagValue && indentation !== "" && (tagValue.includes("/>") || tagValue.includes("</"))) {
                xmlStr += indentation + options.indentBy + tagValue + indentation;
            } else {
                xmlStr += tagValue;
            }
            xmlStr += `</${tagName}>`;
        }
        isPreviousElementTag = true;
    }

    return xmlStr;
}

function propName(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if(!obj.hasOwnProperty(key)) continue;
        if (key !== ":@") return key;
    }
}

function attr_to_str(attrMap, options) {
    let attrStr = "";
    if (attrMap && !options.ignoreAttributes) {
        for (let attr in attrMap) {
            if(!attrMap.hasOwnProperty(attr)) continue;
            let attrVal = options.attributeValueProcessor(attr, attrMap[attr]);
            attrVal = replaceEntitiesValue(attrVal, options);
            if (attrVal === true && options.suppressBooleanAttributes) {
                attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}`;
            } else {
                attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}="${attrVal}"`;
            }
        }
    }
    return attrStr;
}

function isStopNode(jPath, options) {
    jPath = jPath.substr(0, jPath.length - options.textNodeName.length - 1);
    let tagName = jPath.substr(jPath.lastIndexOf(".") + 1);
    for (let index in options.stopNodes) {
        if (options.stopNodes[index] === jPath || options.stopNodes[index] === "*." + tagName) return true;
    }
    return false;
}

function replaceEntitiesValue(textValue, options) {
    if (textValue && textValue.length > 0 && options.processEntities) {
        for (let i = 0; i < options.entities.length; i++) {
            const entity = options.entities[i];
            textValue = textValue.replace(entity.regex, entity.val);
        }
    }
    return textValue;
}
var orderedJs2Xml = toXml;

//parse Empty Node as self closing node
const buildFromOrderedJs = orderedJs2Xml;

const defaultOptions = {
  attributeNamePrefix: '@_',
  attributesGroupName: false,
  textNodeName: '#text',
  ignoreAttributes: true,
  cdataPropName: false,
  format: false,
  indentBy: '  ',
  suppressEmptyNode: false,
  suppressUnpairedNode: true,
  suppressBooleanAttributes: true,
  tagValueProcessor: function(key, a) {
    return a;
  },
  attributeValueProcessor: function(attrName, a) {
    return a;
  },
  preserveOrder: false,
  commentPropName: false,
  unpairedTags: [],
  entities: [
    { regex: new RegExp("&", "g"), val: "&amp;" },//it must be on top
    { regex: new RegExp(">", "g"), val: "&gt;" },
    { regex: new RegExp("<", "g"), val: "&lt;" },
    { regex: new RegExp("\'", "g"), val: "&apos;" },
    { regex: new RegExp("\"", "g"), val: "&quot;" }
  ],
  processEntities: true,
  stopNodes: [],
  // transformTagName: false,
  // transformAttributeName: false,
  oneListGroup: false
};

function Builder(options) {
  this.options = Object.assign({}, defaultOptions, options);
  if (this.options.ignoreAttributes || this.options.attributesGroupName) {
    this.isAttribute = function(/*a*/) {
      return false;
    };
  } else {
    this.attrPrefixLen = this.options.attributeNamePrefix.length;
    this.isAttribute = isAttribute;
  }

  this.processTextOrObjNode = processTextOrObjNode;

  if (this.options.format) {
    this.indentate = indentate;
    this.tagEndChar = '>\n';
    this.newLine = '\n';
  } else {
    this.indentate = function() {
      return '';
    };
    this.tagEndChar = '>';
    this.newLine = '';
  }
}

Builder.prototype.build = function(jObj) {
  if(this.options.preserveOrder){
    return buildFromOrderedJs(jObj, this.options);
  }else {
    if(Array.isArray(jObj) && this.options.arrayNodeName && this.options.arrayNodeName.length > 1){
      jObj = {
        [this.options.arrayNodeName] : jObj
      };
    }
    return this.j2x(jObj, 0).val;
  }
};

Builder.prototype.j2x = function(jObj, level) {
  let attrStr = '';
  let val = '';
  for (let key in jObj) {
    if(!Object.prototype.hasOwnProperty.call(jObj, key)) continue;
    if (typeof jObj[key] === 'undefined') {
      // supress undefined node only if it is not an attribute
      if (this.isAttribute(key)) {
        val += '';
      }
    } else if (jObj[key] === null) {
      // null attribute should be ignored by the attribute list, but should not cause the tag closing
      if (this.isAttribute(key)) {
        val += '';
      } else if (key[0] === '?') {
        val += this.indentate(level) + '<' + key + '?' + this.tagEndChar;
      } else {
        val += this.indentate(level) + '<' + key + '/' + this.tagEndChar;
      }
      // val += this.indentate(level) + '<' + key + '/' + this.tagEndChar;
    } else if (jObj[key] instanceof Date) {
      val += this.buildTextValNode(jObj[key], key, '', level);
    } else if (typeof jObj[key] !== 'object') {
      //premitive type
      const attr = this.isAttribute(key);
      if (attr) {
        attrStr += this.buildAttrPairStr(attr, '' + jObj[key]);
      }else {
        //tag value
        if (key === this.options.textNodeName) {
          let newval = this.options.tagValueProcessor(key, '' + jObj[key]);
          val += this.replaceEntitiesValue(newval);
        } else {
          val += this.buildTextValNode(jObj[key], key, '', level);
        }
      }
    } else if (Array.isArray(jObj[key])) {
      //repeated nodes
      const arrLen = jObj[key].length;
      let listTagVal = "";
      let listTagAttr = "";
      for (let j = 0; j < arrLen; j++) {
        const item = jObj[key][j];
        if (typeof item === 'undefined') ; else if (item === null) {
          if(key[0] === "?") val += this.indentate(level) + '<' + key + '?' + this.tagEndChar;
          else val += this.indentate(level) + '<' + key + '/' + this.tagEndChar;
          // val += this.indentate(level) + '<' + key + '/' + this.tagEndChar;
        } else if (typeof item === 'object') {
          if(this.options.oneListGroup){
            const result = this.j2x(item, level + 1);
            listTagVal += result.val;
            if (this.options.attributesGroupName && item.hasOwnProperty(this.options.attributesGroupName)) {
              listTagAttr += result.attrStr;
            }
          }else {
            listTagVal += this.processTextOrObjNode(item, key, level);
          }
        } else {
          if (this.options.oneListGroup) {
            let textValue = this.options.tagValueProcessor(key, item);
            textValue = this.replaceEntitiesValue(textValue);
            listTagVal += textValue;
          } else {
            listTagVal += this.buildTextValNode(item, key, '', level);
          }
        }
      }
      if(this.options.oneListGroup){
        listTagVal = this.buildObjectNode(listTagVal, key, listTagAttr, level);
      }
      val += listTagVal;
    } else {
      //nested node
      if (this.options.attributesGroupName && key === this.options.attributesGroupName) {
        const Ks = Object.keys(jObj[key]);
        const L = Ks.length;
        for (let j = 0; j < L; j++) {
          attrStr += this.buildAttrPairStr(Ks[j], '' + jObj[key][Ks[j]]);
        }
      } else {
        val += this.processTextOrObjNode(jObj[key], key, level);
      }
    }
  }
  return {attrStr: attrStr, val: val};
};

Builder.prototype.buildAttrPairStr = function(attrName, val){
  val = this.options.attributeValueProcessor(attrName, '' + val);
  val = this.replaceEntitiesValue(val);
  if (this.options.suppressBooleanAttributes && val === "true") {
    return ' ' + attrName;
  } else return ' ' + attrName + '="' + val + '"';
};

function processTextOrObjNode (object, key, level) {
  const result = this.j2x(object, level + 1);
  if (object[this.options.textNodeName] !== undefined && Object.keys(object).length === 1) {
    return this.buildTextValNode(object[this.options.textNodeName], key, result.attrStr, level);
  } else {
    return this.buildObjectNode(result.val, key, result.attrStr, level);
  }
}

Builder.prototype.buildObjectNode = function(val, key, attrStr, level) {
  if(val === ""){
    if(key[0] === "?") return  this.indentate(level) + '<' + key + attrStr+ '?' + this.tagEndChar;
    else {
      return this.indentate(level) + '<' + key + attrStr + this.closeTag(key) + this.tagEndChar;
    }
  }else {

    let tagEndExp = '</' + key + this.tagEndChar;
    let piClosingChar = "";
    
    if(key[0] === "?") {
      piClosingChar = "?";
      tagEndExp = "";
    }
  
    // attrStr is an empty string in case the attribute came as undefined or null
    if ((attrStr || attrStr === '') && val.indexOf('<') === -1) {
      return ( this.indentate(level) + '<' +  key + attrStr + piClosingChar + '>' + val + tagEndExp );
    } else if (this.options.commentPropName !== false && key === this.options.commentPropName && piClosingChar.length === 0) {
      return this.indentate(level) + `<!--${val}-->` + this.newLine;
    }else {
      return (
        this.indentate(level) + '<' + key + attrStr + piClosingChar + this.tagEndChar +
        val +
        this.indentate(level) + tagEndExp    );
    }
  }
};

Builder.prototype.closeTag = function(key){
  let closeTag = "";
  if(this.options.unpairedTags.indexOf(key) !== -1){ //unpaired
    if(!this.options.suppressUnpairedNode) closeTag = "/";
  }else if(this.options.suppressEmptyNode){ //empty
    closeTag = "/";
  }else {
    closeTag = `></${key}`;
  }
  return closeTag;
};

Builder.prototype.buildTextValNode = function(val, key, attrStr, level) {
  if (this.options.cdataPropName !== false && key === this.options.cdataPropName) {
    return this.indentate(level) + `<![CDATA[${val}]]>` +  this.newLine;
  }else if (this.options.commentPropName !== false && key === this.options.commentPropName) {
    return this.indentate(level) + `<!--${val}-->` +  this.newLine;
  }else if(key[0] === "?") {//PI tag
    return  this.indentate(level) + '<' + key + attrStr+ '?' + this.tagEndChar; 
  }else {
    let textValue = this.options.tagValueProcessor(key, val);
    textValue = this.replaceEntitiesValue(textValue);
  
    if( textValue === ''){
      return this.indentate(level) + '<' + key + attrStr + this.closeTag(key) + this.tagEndChar;
    }else {
      return this.indentate(level) + '<' + key + attrStr + '>' +
         textValue +
        '</' + key + this.tagEndChar;
    }
  }
};

Builder.prototype.replaceEntitiesValue = function(textValue){
  if(textValue && textValue.length > 0 && this.options.processEntities){
    for (let i=0; i<this.options.entities.length; i++) {
      const entity = this.options.entities[i];
      textValue = textValue.replace(entity.regex, entity.val);
    }
  }
  return textValue;
};

function indentate(level) {
  return this.options.indentBy.repeat(level);
}

function isAttribute(name /*, options*/) {
  if (name.startsWith(this.options.attributeNamePrefix) && name !== this.options.textNodeName) {
    return name.substr(this.attrPrefixLen);
  } else {
    return false;
  }
}

var json2xml = Builder;

const validator = validator$2;
const XMLParser = XMLParser_1;
const XMLBuilder = json2xml;

var fxp = {
  XMLParser: XMLParser,
  XMLValidator: validator,
  XMLBuilder: XMLBuilder
};

const parseXmlBody = (streamBody, context) => collectBodyString(streamBody, context).then((encoded) => {
    if (encoded.length) {
        const parser = new fxp.XMLParser({
            attributeNamePrefix: "",
            htmlEntities: true,
            ignoreAttributes: false,
            ignoreDeclaration: true,
            parseTagValue: false,
            trimValues: false,
            tagValueProcessor: (_, val) => (val.trim() === "" && val.includes("\n") ? "" : undefined),
        });
        parser.addEntity("#xD", "\r");
        parser.addEntity("#10", "\n");
        let parsedObj;
        try {
            parsedObj = parser.parse(encoded, true);
        }
        catch (e) {
            if (e && typeof e === "object") {
                Object.defineProperty(e, "$responseBodyText", {
                    value: encoded,
                });
            }
            throw e;
        }
        const textNodeName = "#text";
        const key = Object.keys(parsedObj)[0];
        const parsedObjToReturn = parsedObj[key];
        if (parsedObjToReturn[textNodeName]) {
            parsedObjToReturn[key] = parsedObjToReturn[textNodeName];
            delete parsedObjToReturn[textNodeName];
        }
        return getValueFromTextNode(parsedObjToReturn);
    }
    return {};
});
const parseXmlErrorBody = async (errorBody, context) => {
    const value = await parseXmlBody(errorBody, context);
    if (value.Error) {
        value.Error.message = value.Error.message ?? value.Error.Message;
    }
    return value;
};
const loadRestXmlErrorCode = (output, data) => {
    if (data?.Error?.Code !== undefined) {
        return data.Error.Code;
    }
    if (data?.Code !== undefined) {
        return data.Code;
    }
    if (output.statusCode == 404) {
        return "NotFound";
    }
};

const CLIENT_SUPPORTED_ALGORITHMS = [
    ChecksumAlgorithm.CRC32,
    ChecksumAlgorithm.CRC32C,
    ChecksumAlgorithm.CRC64NVME,
    ChecksumAlgorithm.SHA1,
    ChecksumAlgorithm.SHA256,
];
const PRIORITY_ORDER_ALGORITHMS = [
    ChecksumAlgorithm.SHA256,
    ChecksumAlgorithm.SHA1,
    ChecksumAlgorithm.CRC32,
    ChecksumAlgorithm.CRC32C,
    ChecksumAlgorithm.CRC64NVME,
];

const getChecksumAlgorithmForRequest = (input, { requestChecksumRequired, requestAlgorithmMember, requestChecksumCalculation }) => {
    if (!requestAlgorithmMember) {
        return requestChecksumCalculation === RequestChecksumCalculation.WHEN_SUPPORTED || requestChecksumRequired
            ? DEFAULT_CHECKSUM_ALGORITHM
            : undefined;
    }
    if (!input[requestAlgorithmMember]) {
        return undefined;
    }
    const checksumAlgorithm = input[requestAlgorithmMember];
    if (!CLIENT_SUPPORTED_ALGORITHMS.includes(checksumAlgorithm)) {
        throw new Error(`The checksum algorithm "${checksumAlgorithm}" is not supported by the client.` +
            ` Select one of ${CLIENT_SUPPORTED_ALGORITHMS}.`);
    }
    return checksumAlgorithm;
};

const getChecksumLocationName = (algorithm) => algorithm === ChecksumAlgorithm.MD5 ? "content-md5" : `x-amz-checksum-${algorithm.toLowerCase()}`;

const hasHeader = (header, headers) => {
    const soughtHeader = header.toLowerCase();
    for (const headerName of Object.keys(headers)) {
        if (soughtHeader === headerName.toLowerCase()) {
            return true;
        }
    }
    return false;
};

const hasHeaderWithPrefix = (headerPrefix, headers) => {
    const soughtHeaderPrefix = headerPrefix.toLowerCase();
    for (const headerName of Object.keys(headers)) {
        if (headerName.toLowerCase().startsWith(soughtHeaderPrefix)) {
            return true;
        }
    }
    return false;
};

const isStreaming = (body) => body !== undefined && typeof body !== "string" && !ArrayBuffer.isView(body) && !isArrayBuffer(body);

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

function __generator(thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
}

function __values(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

const fromString = (input, encoding) => {
    if (typeof input !== "string") {
        throw new TypeError(`The "input" argument must be of type string. Received type ${typeof input} (${input})`);
    }
    return encoding ? Buffer$1.from(input, encoding) : Buffer$1.from(input);
};

const fromUtf8$1 = (input) => {
    const buf = fromString(input, "utf8");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint8Array.BYTES_PER_ELEMENT);
};

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
// Quick polyfill
var fromUtf8 = typeof Buffer !== "undefined" && Buffer.from
    ? function (input) { return Buffer.from(input, "utf8"); }
    : fromUtf8$1;
function convertToBuffer(data) {
    // Already a Uint8, do nothing
    if (data instanceof Uint8Array)
        return data;
    if (typeof data === "string") {
        return fromUtf8(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
    }
    return new Uint8Array(data);
}

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
function isEmptyData(data) {
    if (typeof data === "string") {
        return data.length === 0;
    }
    return data.byteLength === 0;
}

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
function numToUint8(num) {
    return new Uint8Array([
        (num & 0xff000000) >> 24,
        (num & 0x00ff0000) >> 16,
        (num & 0x0000ff00) >> 8,
        num & 0x000000ff,
    ]);
}

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// IE 11 does not support Array.from, so we do it manually
function uint32ArrayFrom(a_lookUpTable) {
    if (!Uint32Array.from) {
        var return_array = new Uint32Array(a_lookUpTable.length);
        var a_index = 0;
        while (a_index < a_lookUpTable.length) {
            return_array[a_index] = a_lookUpTable[a_index];
            a_index += 1;
        }
        return return_array;
    }
    return Uint32Array.from(a_lookUpTable);
}

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
var AwsCrc32c = /** @class */ (function () {
    function AwsCrc32c() {
        this.crc32c = new Crc32c();
    }
    AwsCrc32c.prototype.update = function (toHash) {
        if (isEmptyData(toHash))
            return;
        this.crc32c.update(convertToBuffer(toHash));
    };
    AwsCrc32c.prototype.digest = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, numToUint8(this.crc32c.digest())];
            });
        });
    };
    AwsCrc32c.prototype.reset = function () {
        this.crc32c = new Crc32c();
    };
    return AwsCrc32c;
}());

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
var Crc32c = /** @class */ (function () {
    function Crc32c() {
        this.checksum = 0xffffffff;
    }
    Crc32c.prototype.update = function (data) {
        var e_1, _a;
        try {
            for (var data_1 = __values(data), data_1_1 = data_1.next(); !data_1_1.done; data_1_1 = data_1.next()) {
                var byte = data_1_1.value;
                this.checksum =
                    (this.checksum >>> 8) ^ lookupTable$1[(this.checksum ^ byte) & 0xff];
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (data_1_1 && !data_1_1.done && (_a = data_1.return)) _a.call(data_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        return this;
    };
    Crc32c.prototype.digest = function () {
        return (this.checksum ^ 0xffffffff) >>> 0;
    };
    return Crc32c;
}());
// prettier-ignore
var a_lookupTable = [
    0x00000000, 0xF26B8303, 0xE13B70F7, 0x1350F3F4, 0xC79A971F, 0x35F1141C, 0x26A1E7E8, 0xD4CA64EB,
    0x8AD958CF, 0x78B2DBCC, 0x6BE22838, 0x9989AB3B, 0x4D43CFD0, 0xBF284CD3, 0xAC78BF27, 0x5E133C24,
    0x105EC76F, 0xE235446C, 0xF165B798, 0x030E349B, 0xD7C45070, 0x25AFD373, 0x36FF2087, 0xC494A384,
    0x9A879FA0, 0x68EC1CA3, 0x7BBCEF57, 0x89D76C54, 0x5D1D08BF, 0xAF768BBC, 0xBC267848, 0x4E4DFB4B,
    0x20BD8EDE, 0xD2D60DDD, 0xC186FE29, 0x33ED7D2A, 0xE72719C1, 0x154C9AC2, 0x061C6936, 0xF477EA35,
    0xAA64D611, 0x580F5512, 0x4B5FA6E6, 0xB93425E5, 0x6DFE410E, 0x9F95C20D, 0x8CC531F9, 0x7EAEB2FA,
    0x30E349B1, 0xC288CAB2, 0xD1D83946, 0x23B3BA45, 0xF779DEAE, 0x05125DAD, 0x1642AE59, 0xE4292D5A,
    0xBA3A117E, 0x4851927D, 0x5B016189, 0xA96AE28A, 0x7DA08661, 0x8FCB0562, 0x9C9BF696, 0x6EF07595,
    0x417B1DBC, 0xB3109EBF, 0xA0406D4B, 0x522BEE48, 0x86E18AA3, 0x748A09A0, 0x67DAFA54, 0x95B17957,
    0xCBA24573, 0x39C9C670, 0x2A993584, 0xD8F2B687, 0x0C38D26C, 0xFE53516F, 0xED03A29B, 0x1F682198,
    0x5125DAD3, 0xA34E59D0, 0xB01EAA24, 0x42752927, 0x96BF4DCC, 0x64D4CECF, 0x77843D3B, 0x85EFBE38,
    0xDBFC821C, 0x2997011F, 0x3AC7F2EB, 0xC8AC71E8, 0x1C661503, 0xEE0D9600, 0xFD5D65F4, 0x0F36E6F7,
    0x61C69362, 0x93AD1061, 0x80FDE395, 0x72966096, 0xA65C047D, 0x5437877E, 0x4767748A, 0xB50CF789,
    0xEB1FCBAD, 0x197448AE, 0x0A24BB5A, 0xF84F3859, 0x2C855CB2, 0xDEEEDFB1, 0xCDBE2C45, 0x3FD5AF46,
    0x7198540D, 0x83F3D70E, 0x90A324FA, 0x62C8A7F9, 0xB602C312, 0x44694011, 0x5739B3E5, 0xA55230E6,
    0xFB410CC2, 0x092A8FC1, 0x1A7A7C35, 0xE811FF36, 0x3CDB9BDD, 0xCEB018DE, 0xDDE0EB2A, 0x2F8B6829,
    0x82F63B78, 0x709DB87B, 0x63CD4B8F, 0x91A6C88C, 0x456CAC67, 0xB7072F64, 0xA457DC90, 0x563C5F93,
    0x082F63B7, 0xFA44E0B4, 0xE9141340, 0x1B7F9043, 0xCFB5F4A8, 0x3DDE77AB, 0x2E8E845F, 0xDCE5075C,
    0x92A8FC17, 0x60C37F14, 0x73938CE0, 0x81F80FE3, 0x55326B08, 0xA759E80B, 0xB4091BFF, 0x466298FC,
    0x1871A4D8, 0xEA1A27DB, 0xF94AD42F, 0x0B21572C, 0xDFEB33C7, 0x2D80B0C4, 0x3ED04330, 0xCCBBC033,
    0xA24BB5A6, 0x502036A5, 0x4370C551, 0xB11B4652, 0x65D122B9, 0x97BAA1BA, 0x84EA524E, 0x7681D14D,
    0x2892ED69, 0xDAF96E6A, 0xC9A99D9E, 0x3BC21E9D, 0xEF087A76, 0x1D63F975, 0x0E330A81, 0xFC588982,
    0xB21572C9, 0x407EF1CA, 0x532E023E, 0xA145813D, 0x758FE5D6, 0x87E466D5, 0x94B49521, 0x66DF1622,
    0x38CC2A06, 0xCAA7A905, 0xD9F75AF1, 0x2B9CD9F2, 0xFF56BD19, 0x0D3D3E1A, 0x1E6DCDEE, 0xEC064EED,
    0xC38D26C4, 0x31E6A5C7, 0x22B65633, 0xD0DDD530, 0x0417B1DB, 0xF67C32D8, 0xE52CC12C, 0x1747422F,
    0x49547E0B, 0xBB3FFD08, 0xA86F0EFC, 0x5A048DFF, 0x8ECEE914, 0x7CA56A17, 0x6FF599E3, 0x9D9E1AE0,
    0xD3D3E1AB, 0x21B862A8, 0x32E8915C, 0xC083125F, 0x144976B4, 0xE622F5B7, 0xF5720643, 0x07198540,
    0x590AB964, 0xAB613A67, 0xB831C993, 0x4A5A4A90, 0x9E902E7B, 0x6CFBAD78, 0x7FAB5E8C, 0x8DC0DD8F,
    0xE330A81A, 0x115B2B19, 0x020BD8ED, 0xF0605BEE, 0x24AA3F05, 0xD6C1BC06, 0xC5914FF2, 0x37FACCF1,
    0x69E9F0D5, 0x9B8273D6, 0x88D28022, 0x7AB90321, 0xAE7367CA, 0x5C18E4C9, 0x4F48173D, 0xBD23943E,
    0xF36E6F75, 0x0105EC76, 0x12551F82, 0xE03E9C81, 0x34F4F86A, 0xC69F7B69, 0xD5CF889D, 0x27A40B9E,
    0x79B737BA, 0x8BDCB4B9, 0x988C474D, 0x6AE7C44E, 0xBE2DA0A5, 0x4C4623A6, 0x5F16D052, 0xAD7D5351,
];
var lookupTable$1 = uint32ArrayFrom(a_lookupTable);

// Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.
var AwsCrc32 = /** @class */ (function () {
    function AwsCrc32() {
        this.crc32 = new Crc32();
    }
    AwsCrc32.prototype.update = function (toHash) {
        if (isEmptyData(toHash))
            return;
        this.crc32.update(convertToBuffer(toHash));
    };
    AwsCrc32.prototype.digest = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, numToUint8(this.crc32.digest())];
            });
        });
    };
    AwsCrc32.prototype.reset = function () {
        this.crc32 = new Crc32();
    };
    return AwsCrc32;
}());

var Crc32 = /** @class */ (function () {
    function Crc32() {
        this.checksum = 0xffffffff;
    }
    Crc32.prototype.update = function (data) {
        var e_1, _a;
        try {
            for (var data_1 = __values(data), data_1_1 = data_1.next(); !data_1_1.done; data_1_1 = data_1.next()) {
                var byte = data_1_1.value;
                this.checksum =
                    (this.checksum >>> 8) ^ lookupTable[(this.checksum ^ byte) & 0xff];
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (data_1_1 && !data_1_1.done && (_a = data_1.return)) _a.call(data_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        return this;
    };
    Crc32.prototype.digest = function () {
        return (this.checksum ^ 0xffffffff) >>> 0;
    };
    return Crc32;
}());
// prettier-ignore
var a_lookUpTable = [
    0x00000000, 0x77073096, 0xEE0E612C, 0x990951BA,
    0x076DC419, 0x706AF48F, 0xE963A535, 0x9E6495A3,
    0x0EDB8832, 0x79DCB8A4, 0xE0D5E91E, 0x97D2D988,
    0x09B64C2B, 0x7EB17CBD, 0xE7B82D07, 0x90BF1D91,
    0x1DB71064, 0x6AB020F2, 0xF3B97148, 0x84BE41DE,
    0x1ADAD47D, 0x6DDDE4EB, 0xF4D4B551, 0x83D385C7,
    0x136C9856, 0x646BA8C0, 0xFD62F97A, 0x8A65C9EC,
    0x14015C4F, 0x63066CD9, 0xFA0F3D63, 0x8D080DF5,
    0x3B6E20C8, 0x4C69105E, 0xD56041E4, 0xA2677172,
    0x3C03E4D1, 0x4B04D447, 0xD20D85FD, 0xA50AB56B,
    0x35B5A8FA, 0x42B2986C, 0xDBBBC9D6, 0xACBCF940,
    0x32D86CE3, 0x45DF5C75, 0xDCD60DCF, 0xABD13D59,
    0x26D930AC, 0x51DE003A, 0xC8D75180, 0xBFD06116,
    0x21B4F4B5, 0x56B3C423, 0xCFBA9599, 0xB8BDA50F,
    0x2802B89E, 0x5F058808, 0xC60CD9B2, 0xB10BE924,
    0x2F6F7C87, 0x58684C11, 0xC1611DAB, 0xB6662D3D,
    0x76DC4190, 0x01DB7106, 0x98D220BC, 0xEFD5102A,
    0x71B18589, 0x06B6B51F, 0x9FBFE4A5, 0xE8B8D433,
    0x7807C9A2, 0x0F00F934, 0x9609A88E, 0xE10E9818,
    0x7F6A0DBB, 0x086D3D2D, 0x91646C97, 0xE6635C01,
    0x6B6B51F4, 0x1C6C6162, 0x856530D8, 0xF262004E,
    0x6C0695ED, 0x1B01A57B, 0x8208F4C1, 0xF50FC457,
    0x65B0D9C6, 0x12B7E950, 0x8BBEB8EA, 0xFCB9887C,
    0x62DD1DDF, 0x15DA2D49, 0x8CD37CF3, 0xFBD44C65,
    0x4DB26158, 0x3AB551CE, 0xA3BC0074, 0xD4BB30E2,
    0x4ADFA541, 0x3DD895D7, 0xA4D1C46D, 0xD3D6F4FB,
    0x4369E96A, 0x346ED9FC, 0xAD678846, 0xDA60B8D0,
    0x44042D73, 0x33031DE5, 0xAA0A4C5F, 0xDD0D7CC9,
    0x5005713C, 0x270241AA, 0xBE0B1010, 0xC90C2086,
    0x5768B525, 0x206F85B3, 0xB966D409, 0xCE61E49F,
    0x5EDEF90E, 0x29D9C998, 0xB0D09822, 0xC7D7A8B4,
    0x59B33D17, 0x2EB40D81, 0xB7BD5C3B, 0xC0BA6CAD,
    0xEDB88320, 0x9ABFB3B6, 0x03B6E20C, 0x74B1D29A,
    0xEAD54739, 0x9DD277AF, 0x04DB2615, 0x73DC1683,
    0xE3630B12, 0x94643B84, 0x0D6D6A3E, 0x7A6A5AA8,
    0xE40ECF0B, 0x9309FF9D, 0x0A00AE27, 0x7D079EB1,
    0xF00F9344, 0x8708A3D2, 0x1E01F268, 0x6906C2FE,
    0xF762575D, 0x806567CB, 0x196C3671, 0x6E6B06E7,
    0xFED41B76, 0x89D32BE0, 0x10DA7A5A, 0x67DD4ACC,
    0xF9B9DF6F, 0x8EBEEFF9, 0x17B7BE43, 0x60B08ED5,
    0xD6D6A3E8, 0xA1D1937E, 0x38D8C2C4, 0x4FDFF252,
    0xD1BB67F1, 0xA6BC5767, 0x3FB506DD, 0x48B2364B,
    0xD80D2BDA, 0xAF0A1B4C, 0x36034AF6, 0x41047A60,
    0xDF60EFC3, 0xA867DF55, 0x316E8EEF, 0x4669BE79,
    0xCB61B38C, 0xBC66831A, 0x256FD2A0, 0x5268E236,
    0xCC0C7795, 0xBB0B4703, 0x220216B9, 0x5505262F,
    0xC5BA3BBE, 0xB2BD0B28, 0x2BB45A92, 0x5CB36A04,
    0xC2D7FFA7, 0xB5D0CF31, 0x2CD99E8B, 0x5BDEAE1D,
    0x9B64C2B0, 0xEC63F226, 0x756AA39C, 0x026D930A,
    0x9C0906A9, 0xEB0E363F, 0x72076785, 0x05005713,
    0x95BF4A82, 0xE2B87A14, 0x7BB12BAE, 0x0CB61B38,
    0x92D28E9B, 0xE5D5BE0D, 0x7CDCEFB7, 0x0BDBDF21,
    0x86D3D2D4, 0xF1D4E242, 0x68DDB3F8, 0x1FDA836E,
    0x81BE16CD, 0xF6B9265B, 0x6FB077E1, 0x18B74777,
    0x88085AE6, 0xFF0F6A70, 0x66063BCA, 0x11010B5C,
    0x8F659EFF, 0xF862AE69, 0x616BFFD3, 0x166CCF45,
    0xA00AE278, 0xD70DD2EE, 0x4E048354, 0x3903B3C2,
    0xA7672661, 0xD06016F7, 0x4969474D, 0x3E6E77DB,
    0xAED16A4A, 0xD9D65ADC, 0x40DF0B66, 0x37D83BF0,
    0xA9BCAE53, 0xDEBB9EC5, 0x47B2CF7F, 0x30B5FFE9,
    0xBDBDF21C, 0xCABAC28A, 0x53B39330, 0x24B4A3A6,
    0xBAD03605, 0xCDD70693, 0x54DE5729, 0x23D967BF,
    0xB3667A2E, 0xC4614AB8, 0x5D681B02, 0x2A6F2B94,
    0xB40BBE37, 0xC30C8EA1, 0x5A05DF1B, 0x2D02EF8D,
];
var lookupTable = uint32ArrayFrom(a_lookUpTable);

class NodeCrc32 {
    checksum = 0;
    update(data) {
        this.checksum = zlib.crc32(data, this.checksum);
    }
    async digest() {
        return numToUint8(this.checksum);
    }
    reset() {
        this.checksum = 0;
    }
}
const getCrc32ChecksumAlgorithmFunction = () => {
    if (typeof zlib.crc32 === "undefined") {
        return AwsCrc32;
    }
    return NodeCrc32;
};

const selectChecksumAlgorithmFunction = (checksumAlgorithm, config) => {
    switch (checksumAlgorithm) {
        case ChecksumAlgorithm.MD5:
            return config.md5;
        case ChecksumAlgorithm.CRC32:
            return getCrc32ChecksumAlgorithmFunction();
        case ChecksumAlgorithm.CRC32C:
            return AwsCrc32c;
        case ChecksumAlgorithm.CRC64NVME:
            {
                throw new Error(`Please check whether you have installed the "@aws-sdk/crc64-nvme-crt" package explicitly. \n` +
                    `You must also register the package by calling [require("@aws-sdk/crc64-nvme-crt");] ` +
                    `or an ESM equivalent such as [import "@aws-sdk/crc64-nvme-crt";]. \n` +
                    "For more information please go to " +
                    "https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt");
            }
        case ChecksumAlgorithm.SHA1:
            return config.sha1;
        case ChecksumAlgorithm.SHA256:
            return config.sha256;
        default:
            throw new Error(`Unsupported checksum algorithm: ${checksumAlgorithm}`);
    }
};

const stringHasher = (checksumAlgorithmFn, body) => {
    const hash = new checksumAlgorithmFn();
    hash.update(toUint8Array(body || ""));
    return hash.digest();
};

const flexibleChecksumsMiddlewareOptions = {
    name: "flexibleChecksumsMiddleware",
    step: "build",
    tags: ["BODY_CHECKSUM"],
    override: true,
};
const flexibleChecksumsMiddleware = (config, middlewareConfig) => (next, context) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
        return next(args);
    }
    if (hasHeaderWithPrefix("x-amz-checksum-", args.request.headers)) {
        return next(args);
    }
    const { request, input } = args;
    const { body: requestBody, headers } = request;
    const { base64Encoder, streamHasher } = config;
    const { requestChecksumRequired, requestAlgorithmMember } = middlewareConfig;
    const requestChecksumCalculation = await config.requestChecksumCalculation();
    const requestAlgorithmMemberName = requestAlgorithmMember?.name;
    const requestAlgorithmMemberHttpHeader = requestAlgorithmMember?.httpHeader;
    if (requestAlgorithmMemberName && !input[requestAlgorithmMemberName]) {
        if (requestChecksumCalculation === RequestChecksumCalculation.WHEN_SUPPORTED || requestChecksumRequired) {
            input[requestAlgorithmMemberName] = DEFAULT_CHECKSUM_ALGORITHM;
            if (requestAlgorithmMemberHttpHeader) {
                headers[requestAlgorithmMemberHttpHeader] = DEFAULT_CHECKSUM_ALGORITHM;
            }
        }
    }
    const checksumAlgorithm = getChecksumAlgorithmForRequest(input, {
        requestChecksumRequired,
        requestAlgorithmMember: requestAlgorithmMember?.name,
        requestChecksumCalculation,
    });
    let updatedBody = requestBody;
    let updatedHeaders = headers;
    if (checksumAlgorithm) {
        switch (checksumAlgorithm) {
            case ChecksumAlgorithm.CRC32:
                setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_CRC32", "U");
                break;
            case ChecksumAlgorithm.CRC32C:
                setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_CRC32C", "V");
                break;
            case ChecksumAlgorithm.CRC64NVME:
                setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_CRC64", "W");
                break;
            case ChecksumAlgorithm.SHA1:
                setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_SHA1", "X");
                break;
            case ChecksumAlgorithm.SHA256:
                setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_SHA256", "Y");
                break;
        }
        const checksumLocationName = getChecksumLocationName(checksumAlgorithm);
        const checksumAlgorithmFn = selectChecksumAlgorithmFunction(checksumAlgorithm, config);
        if (isStreaming(requestBody)) {
            const { getAwsChunkedEncodingStream, bodyLengthChecker } = config;
            updatedBody = getAwsChunkedEncodingStream(requestBody, {
                base64Encoder,
                bodyLengthChecker,
                checksumLocationName,
                checksumAlgorithmFn,
                streamHasher,
            });
            updatedHeaders = {
                ...headers,
                "content-encoding": headers["content-encoding"]
                    ? `${headers["content-encoding"]},aws-chunked`
                    : "aws-chunked",
                "transfer-encoding": "chunked",
                "x-amz-decoded-content-length": headers["content-length"],
                "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
                "x-amz-trailer": checksumLocationName,
            };
            delete updatedHeaders["content-length"];
        }
        else if (!hasHeader(checksumLocationName, headers)) {
            const rawChecksum = await stringHasher(checksumAlgorithmFn, requestBody);
            updatedHeaders = {
                ...headers,
                [checksumLocationName]: base64Encoder(rawChecksum),
            };
        }
    }
    const result = await next({
        ...args,
        request: {
            ...request,
            headers: updatedHeaders,
            body: updatedBody,
        },
    });
    return result;
};

const flexibleChecksumsInputMiddlewareOptions = {
    name: "flexibleChecksumsInputMiddleware",
    toMiddleware: "serializerMiddleware",
    relation: "before",
    tags: ["BODY_CHECKSUM"],
    override: true,
};
const flexibleChecksumsInputMiddleware = (config, middlewareConfig) => (next, context) => async (args) => {
    const input = args.input;
    const { requestValidationModeMember } = middlewareConfig;
    const requestChecksumCalculation = await config.requestChecksumCalculation();
    const responseChecksumValidation = await config.responseChecksumValidation();
    switch (requestChecksumCalculation) {
        case RequestChecksumCalculation.WHEN_REQUIRED:
            setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_WHEN_REQUIRED", "a");
            break;
        case RequestChecksumCalculation.WHEN_SUPPORTED:
            setFeature$1(context, "FLEXIBLE_CHECKSUMS_REQ_WHEN_SUPPORTED", "Z");
            break;
    }
    switch (responseChecksumValidation) {
        case ResponseChecksumValidation.WHEN_REQUIRED:
            setFeature$1(context, "FLEXIBLE_CHECKSUMS_RES_WHEN_REQUIRED", "c");
            break;
        case ResponseChecksumValidation.WHEN_SUPPORTED:
            setFeature$1(context, "FLEXIBLE_CHECKSUMS_RES_WHEN_SUPPORTED", "b");
            break;
    }
    if (requestValidationModeMember && !input[requestValidationModeMember]) {
        if (responseChecksumValidation === ResponseChecksumValidation.WHEN_SUPPORTED) {
            input[requestValidationModeMember] = "ENABLED";
        }
    }
    return next(args);
};

const getChecksumAlgorithmListForResponse = (responseAlgorithms = []) => {
    const validChecksumAlgorithms = [];
    for (const algorithm of PRIORITY_ORDER_ALGORITHMS) {
        if (!responseAlgorithms.includes(algorithm) || !CLIENT_SUPPORTED_ALGORITHMS.includes(algorithm)) {
            continue;
        }
        validChecksumAlgorithms.push(algorithm);
    }
    return validChecksumAlgorithms;
};

const isChecksumWithPartNumber = (checksum) => {
    const lastHyphenIndex = checksum.lastIndexOf("-");
    if (lastHyphenIndex !== -1) {
        const numberPart = checksum.slice(lastHyphenIndex + 1);
        if (!numberPart.startsWith("0")) {
            const number = parseInt(numberPart, 10);
            if (!isNaN(number) && number >= 1 && number <= 10000) {
                return true;
            }
        }
    }
    return false;
};

const getChecksum = async (body, { checksumAlgorithmFn, base64Encoder }) => base64Encoder(await stringHasher(checksumAlgorithmFn, body));

const validateChecksumFromResponse = async (response, { config, responseAlgorithms, logger }) => {
    const checksumAlgorithms = getChecksumAlgorithmListForResponse(responseAlgorithms);
    const { body: responseBody, headers: responseHeaders } = response;
    for (const algorithm of checksumAlgorithms) {
        const responseHeader = getChecksumLocationName(algorithm);
        const checksumFromResponse = responseHeaders[responseHeader];
        if (checksumFromResponse) {
            let checksumAlgorithmFn;
            try {
                checksumAlgorithmFn = selectChecksumAlgorithmFunction(algorithm, config);
            }
            catch (error) {
                if (algorithm === ChecksumAlgorithm.CRC64NVME) {
                    logger?.warn(`Skipping ${ChecksumAlgorithm.CRC64NVME} checksum validation: ${error.message}`);
                    continue;
                }
                throw error;
            }
            const { base64Encoder } = config;
            if (isStreaming(responseBody)) {
                response.body = createChecksumStream({
                    expectedChecksum: checksumFromResponse,
                    checksumSourceLocation: responseHeader,
                    checksum: new checksumAlgorithmFn(),
                    source: responseBody,
                    base64Encoder,
                });
                return;
            }
            const checksum = await getChecksum(responseBody, { checksumAlgorithmFn, base64Encoder });
            if (checksum === checksumFromResponse) {
                break;
            }
            throw new Error(`Checksum mismatch: expected "${checksum}" but received "${checksumFromResponse}"` +
                ` in response header "${responseHeader}".`);
        }
    }
};

const flexibleChecksumsResponseMiddlewareOptions = {
    name: "flexibleChecksumsResponseMiddleware",
    toMiddleware: "deserializerMiddleware",
    relation: "after",
    tags: ["BODY_CHECKSUM"],
    override: true,
};
const flexibleChecksumsResponseMiddleware = (config, middlewareConfig) => (next, context) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
        return next(args);
    }
    const input = args.input;
    const result = await next(args);
    const response = result.response;
    const { requestValidationModeMember, responseAlgorithms } = middlewareConfig;
    if (requestValidationModeMember && input[requestValidationModeMember] === "ENABLED") {
        const { clientName, commandName } = context;
        const isS3WholeObjectMultipartGetResponseChecksum = clientName === "S3Client" &&
            commandName === "GetObjectCommand" &&
            getChecksumAlgorithmListForResponse(responseAlgorithms).every((algorithm) => {
                const responseHeader = getChecksumLocationName(algorithm);
                const checksumFromResponse = response.headers[responseHeader];
                return !checksumFromResponse || isChecksumWithPartNumber(checksumFromResponse);
            });
        if (isS3WholeObjectMultipartGetResponseChecksum) {
            return result;
        }
        await validateChecksumFromResponse(response, {
            config,
            responseAlgorithms,
            logger: context.logger,
        });
    }
    return result;
};

const getFlexibleChecksumsPlugin = (config, middlewareConfig) => ({
    applyToStack: (clientStack) => {
        clientStack.add(flexibleChecksumsMiddleware(config, middlewareConfig), flexibleChecksumsMiddlewareOptions);
        clientStack.addRelativeTo(flexibleChecksumsInputMiddleware(config, middlewareConfig), flexibleChecksumsInputMiddlewareOptions);
        clientStack.addRelativeTo(flexibleChecksumsResponseMiddleware(config, middlewareConfig), flexibleChecksumsResponseMiddlewareOptions);
    },
});

const resolveFlexibleChecksumsConfig = (input) => ({
    ...input,
    requestChecksumCalculation: normalizeProvider$1(input.requestChecksumCalculation ?? DEFAULT_REQUEST_CHECKSUM_CALCULATION),
    responseChecksumValidation: normalizeProvider$1(input.responseChecksumValidation ?? DEFAULT_RESPONSE_CHECKSUM_VALIDATION),
});

function resolveHostHeaderConfig(input) {
    return input;
}
const hostHeaderMiddleware = (options) => (next) => async (args) => {
    if (!HttpRequest.isInstance(args.request))
        return next(args);
    const { request } = args;
    const { handlerProtocol = "" } = options.requestHandler.metadata || {};
    if (handlerProtocol.indexOf("h2") >= 0 && !request.headers[":authority"]) {
        delete request.headers["host"];
        request.headers[":authority"] = request.hostname + (request.port ? ":" + request.port : "");
    }
    else if (!request.headers["host"]) {
        let host = request.hostname;
        if (request.port != null)
            host += `:${request.port}`;
        request.headers["host"] = host;
    }
    return next(args);
};
const hostHeaderMiddlewareOptions = {
    name: "hostHeaderMiddleware",
    step: "build",
    priority: "low",
    tags: ["HOST"],
    override: true,
};
const getHostHeaderPlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(hostHeaderMiddleware(options), hostHeaderMiddlewareOptions);
    },
});

const loggerMiddleware = () => (next, context) => async (args) => {
    try {
        const response = await next(args);
        const { clientName, commandName, logger, dynamoDbDocumentClientOptions = {} } = context;
        const { overrideInputFilterSensitiveLog, overrideOutputFilterSensitiveLog } = dynamoDbDocumentClientOptions;
        const inputFilterSensitiveLog = overrideInputFilterSensitiveLog ?? context.inputFilterSensitiveLog;
        const outputFilterSensitiveLog = overrideOutputFilterSensitiveLog ?? context.outputFilterSensitiveLog;
        const { $metadata, ...outputWithoutMetadata } = response.output;
        logger?.info?.({
            clientName,
            commandName,
            input: inputFilterSensitiveLog(args.input),
            output: outputFilterSensitiveLog(outputWithoutMetadata),
            metadata: $metadata,
        });
        return response;
    }
    catch (error) {
        const { clientName, commandName, logger, dynamoDbDocumentClientOptions = {} } = context;
        const { overrideInputFilterSensitiveLog } = dynamoDbDocumentClientOptions;
        const inputFilterSensitiveLog = overrideInputFilterSensitiveLog ?? context.inputFilterSensitiveLog;
        logger?.error?.({
            clientName,
            commandName,
            input: inputFilterSensitiveLog(args.input),
            error,
            metadata: error.$metadata,
        });
        throw error;
    }
};
const loggerMiddlewareOptions = {
    name: "loggerMiddleware",
    tags: ["LOGGER"],
    step: "initialize",
    override: true,
};
const getLoggerPlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(loggerMiddleware(), loggerMiddlewareOptions);
    },
});

const TRACE_ID_HEADER_NAME = "X-Amzn-Trace-Id";
const ENV_LAMBDA_FUNCTION_NAME = "AWS_LAMBDA_FUNCTION_NAME";
const ENV_TRACE_ID = "_X_AMZN_TRACE_ID";
const recursionDetectionMiddleware = (options) => (next) => async (args) => {
    const { request } = args;
    if (!HttpRequest.isInstance(request) ||
        options.runtime !== "node" ||
        request.headers.hasOwnProperty(TRACE_ID_HEADER_NAME)) {
        return next(args);
    }
    const functionName = process.env[ENV_LAMBDA_FUNCTION_NAME];
    const traceId = process.env[ENV_TRACE_ID];
    const nonEmptyString = (str) => typeof str === "string" && str.length > 0;
    if (nonEmptyString(functionName) && nonEmptyString(traceId)) {
        request.headers[TRACE_ID_HEADER_NAME] = traceId;
    }
    return next({
        ...args,
        request,
    });
};
const addRecursionDetectionMiddlewareOptions = {
    step: "build",
    tags: ["RECURSION_DETECTION"],
    name: "recursionDetectionMiddleware",
    override: true,
    priority: "low",
};
const getRecursionDetectionPlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(recursionDetectionMiddleware(options), addRecursionDetectionMiddlewareOptions);
    },
});

const regionRedirectEndpointMiddleware = (config) => {
    return (next, context) => async (args) => {
        const originalRegion = await config.region();
        const regionProviderRef = config.region;
        let unlock = () => { };
        if (context.__s3RegionRedirect) {
            Object.defineProperty(config, "region", {
                writable: false,
                value: async () => {
                    return context.__s3RegionRedirect;
                },
            });
            unlock = () => Object.defineProperty(config, "region", {
                writable: true,
                value: regionProviderRef,
            });
        }
        try {
            const result = await next(args);
            if (context.__s3RegionRedirect) {
                unlock();
                const region = await config.region();
                if (originalRegion !== region) {
                    throw new Error("Region was not restored following S3 region redirect.");
                }
            }
            return result;
        }
        catch (e) {
            unlock();
            throw e;
        }
    };
};
const regionRedirectEndpointMiddlewareOptions = {
    tags: ["REGION_REDIRECT", "S3"],
    name: "regionRedirectEndpointMiddleware",
    override: true,
    relation: "before",
    toMiddleware: "endpointV2Middleware",
};

function regionRedirectMiddleware(clientConfig) {
    return (next, context) => async (args) => {
        try {
            return await next(args);
        }
        catch (err) {
            if (clientConfig.followRegionRedirects) {
                if (err?.$metadata?.httpStatusCode === 301 ||
                    (err?.$metadata?.httpStatusCode === 400 && err?.name === "IllegalLocationConstraintException")) {
                    try {
                        const actualRegion = err.$response.headers["x-amz-bucket-region"];
                        context.logger?.debug(`Redirecting from ${await clientConfig.region()} to ${actualRegion}`);
                        context.__s3RegionRedirect = actualRegion;
                    }
                    catch (e) {
                        throw new Error("Region redirect failed: " + e);
                    }
                    return next(args);
                }
            }
            throw err;
        }
    };
}
const regionRedirectMiddlewareOptions = {
    step: "initialize",
    tags: ["REGION_REDIRECT", "S3"],
    name: "regionRedirectMiddleware",
    override: true,
};
const getRegionRedirectMiddlewarePlugin = (clientConfig) => ({
    applyToStack: (clientStack) => {
        clientStack.add(regionRedirectMiddleware(clientConfig), regionRedirectMiddlewareOptions);
        clientStack.addRelativeTo(regionRedirectEndpointMiddleware(clientConfig), regionRedirectEndpointMiddlewareOptions);
    },
});

const s3ExpiresMiddleware = (config) => {
    return (next, context) => async (args) => {
        const result = await next(args);
        const { response } = result;
        if (HttpResponse.isInstance(response)) {
            if (response.headers.expires) {
                response.headers.expiresstring = response.headers.expires;
                try {
                    parseRfc7231DateTime(response.headers.expires);
                }
                catch (e) {
                    context.logger?.warn(`AWS SDK Warning for ${context.clientName}::${context.commandName} response parsing (${response.headers.expires}): ${e}`);
                    delete response.headers.expires;
                }
            }
        }
        return result;
    };
};
const s3ExpiresMiddlewareOptions = {
    tags: ["S3"],
    name: "s3ExpiresMiddleware",
    override: true,
    relation: "after",
    toMiddleware: "deserializerMiddleware",
};
const getS3ExpiresMiddlewarePlugin = (clientConfig) => ({
    applyToStack: (clientStack) => {
        clientStack.addRelativeTo(s3ExpiresMiddleware(), s3ExpiresMiddlewareOptions);
    },
});

class S3ExpressIdentityCache {
    data;
    lastPurgeTime = Date.now();
    static EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS = 30000;
    constructor(data = {}) {
        this.data = data;
    }
    get(key) {
        const entry = this.data[key];
        if (!entry) {
            return;
        }
        return entry;
    }
    set(key, entry) {
        this.data[key] = entry;
        return entry;
    }
    delete(key) {
        delete this.data[key];
    }
    async purgeExpired() {
        const now = Date.now();
        if (this.lastPurgeTime + S3ExpressIdentityCache.EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS > now) {
            return;
        }
        for (const key in this.data) {
            const entry = this.data[key];
            if (!entry.isRefreshing) {
                const credential = await entry.identity;
                if (credential.expiration) {
                    if (credential.expiration.getTime() < now) {
                        delete this.data[key];
                    }
                }
            }
        }
    }
}

class S3ExpressIdentityCacheEntry {
    _identity;
    isRefreshing;
    accessed;
    constructor(_identity, isRefreshing = false, accessed = Date.now()) {
        this._identity = _identity;
        this.isRefreshing = isRefreshing;
        this.accessed = accessed;
    }
    get identity() {
        this.accessed = Date.now();
        return this._identity;
    }
}

class S3ExpressIdentityProviderImpl {
    createSessionFn;
    cache;
    static REFRESH_WINDOW_MS = 60000;
    constructor(createSessionFn, cache = new S3ExpressIdentityCache()) {
        this.createSessionFn = createSessionFn;
        this.cache = cache;
    }
    async getS3ExpressIdentity(awsIdentity, identityProperties) {
        const key = identityProperties.Bucket;
        const { cache } = this;
        const entry = cache.get(key);
        if (entry) {
            return entry.identity.then((identity) => {
                const isExpired = (identity.expiration?.getTime() ?? 0) < Date.now();
                if (isExpired) {
                    return cache.set(key, new S3ExpressIdentityCacheEntry(this.getIdentity(key))).identity;
                }
                const isExpiringSoon = (identity.expiration?.getTime() ?? 0) < Date.now() + S3ExpressIdentityProviderImpl.REFRESH_WINDOW_MS;
                if (isExpiringSoon && !entry.isRefreshing) {
                    entry.isRefreshing = true;
                    this.getIdentity(key).then((id) => {
                        cache.set(key, new S3ExpressIdentityCacheEntry(Promise.resolve(id)));
                    });
                }
                return identity;
            });
        }
        return cache.set(key, new S3ExpressIdentityCacheEntry(this.getIdentity(key))).identity;
    }
    async getIdentity(key) {
        await this.cache.purgeExpired().catch((error) => {
            console.warn("Error while clearing expired entries in S3ExpressIdentityCache: \n" + error);
        });
        const session = await this.createSessionFn(key);
        if (!session.Credentials?.AccessKeyId || !session.Credentials?.SecretAccessKey) {
            throw new Error("s3#createSession response credential missing AccessKeyId or SecretAccessKey.");
        }
        const identity = {
            accessKeyId: session.Credentials.AccessKeyId,
            secretAccessKey: session.Credentials.SecretAccessKey,
            sessionToken: session.Credentials.SessionToken,
            expiration: session.Credentials.Expiration ? new Date(session.Credentials.Expiration) : undefined,
        };
        return identity;
    }
}

const booleanSelector = (obj, key, type) => {
    if (!(key in obj))
        return undefined;
    if (obj[key] === "true")
        return true;
    if (obj[key] === "false")
        return false;
    throw new Error(`Cannot load ${type} "${key}". Expected "true" or "false", got ${obj[key]}.`);
};

var SelectorType;
(function (SelectorType) {
    SelectorType["ENV"] = "env";
    SelectorType["CONFIG"] = "shared config entry";
})(SelectorType || (SelectorType = {}));

const S3_EXPRESS_BUCKET_TYPE = "Directory";
const S3_EXPRESS_BACKEND = "S3Express";
const S3_EXPRESS_AUTH_SCHEME = "sigv4-s3express";
const SESSION_TOKEN_QUERY_PARAM = "X-Amz-S3session-Token";
const SESSION_TOKEN_HEADER = SESSION_TOKEN_QUERY_PARAM.toLowerCase();
const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_ENV_NAME = "AWS_S3_DISABLE_EXPRESS_SESSION_AUTH";
const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_INI_NAME = "s3_disable_express_session_auth";
const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS = {
    environmentVariableSelector: (env) => booleanSelector(env, NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_ENV_NAME, SelectorType.ENV),
    configFileSelector: (profile) => booleanSelector(profile, NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_INI_NAME, SelectorType.CONFIG),
    default: false,
};

class SignatureV4S3Express extends SignatureV4 {
    async signWithCredentials(requestToSign, credentials, options) {
        const credentialsWithoutSessionToken = getCredentialsWithoutSessionToken(credentials);
        requestToSign.headers[SESSION_TOKEN_HEADER] = credentials.sessionToken;
        const privateAccess = this;
        setSingleOverride(privateAccess, credentialsWithoutSessionToken);
        return privateAccess.signRequest(requestToSign, options ?? {});
    }
    async presignWithCredentials(requestToSign, credentials, options) {
        const credentialsWithoutSessionToken = getCredentialsWithoutSessionToken(credentials);
        delete requestToSign.headers[SESSION_TOKEN_HEADER];
        requestToSign.headers[SESSION_TOKEN_QUERY_PARAM] = credentials.sessionToken;
        requestToSign.query = requestToSign.query ?? {};
        requestToSign.query[SESSION_TOKEN_QUERY_PARAM] = credentials.sessionToken;
        const privateAccess = this;
        setSingleOverride(privateAccess, credentialsWithoutSessionToken);
        return this.presign(requestToSign, options);
    }
}
function getCredentialsWithoutSessionToken(credentials) {
    const credentialsWithoutSessionToken = {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        expiration: credentials.expiration,
    };
    return credentialsWithoutSessionToken;
}
function setSingleOverride(privateAccess, credentialsWithoutSessionToken) {
    const id = setTimeout(() => {
        throw new Error("SignatureV4S3Express credential override was created but not called.");
    }, 10);
    const currentCredentialProvider = privateAccess.credentialProvider;
    const overrideCredentialsProviderOnce = () => {
        clearTimeout(id);
        privateAccess.credentialProvider = currentCredentialProvider;
        return Promise.resolve(credentialsWithoutSessionToken);
    };
    privateAccess.credentialProvider = overrideCredentialsProviderOnce;
}

const s3ExpressMiddleware = (options) => {
    return (next, context) => async (args) => {
        if (context.endpointV2) {
            const endpoint = context.endpointV2;
            const isS3ExpressAuth = endpoint.properties?.authSchemes?.[0]?.name === S3_EXPRESS_AUTH_SCHEME;
            const isS3ExpressBucket = endpoint.properties?.backend === S3_EXPRESS_BACKEND ||
                endpoint.properties?.bucketType === S3_EXPRESS_BUCKET_TYPE;
            if (isS3ExpressBucket) {
                setFeature$1(context, "S3_EXPRESS_BUCKET", "J");
                context.isS3ExpressBucket = true;
            }
            if (isS3ExpressAuth) {
                const requestBucket = args.input.Bucket;
                if (requestBucket) {
                    const s3ExpressIdentity = await options.s3ExpressIdentityProvider.getS3ExpressIdentity(await options.credentials(), {
                        Bucket: requestBucket,
                    });
                    context.s3ExpressIdentity = s3ExpressIdentity;
                    if (HttpRequest.isInstance(args.request) && s3ExpressIdentity.sessionToken) {
                        args.request.headers[SESSION_TOKEN_HEADER] = s3ExpressIdentity.sessionToken;
                    }
                }
            }
        }
        return next(args);
    };
};
const s3ExpressMiddlewareOptions = {
    name: "s3ExpressMiddleware",
    step: "build",
    tags: ["S3", "S3_EXPRESS"],
    override: true,
};
const getS3ExpressPlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(s3ExpressMiddleware(options), s3ExpressMiddlewareOptions);
    },
});

const signS3Express = async (s3ExpressIdentity, signingOptions, request, sigV4MultiRegionSigner) => {
    const signedRequest = await sigV4MultiRegionSigner.signWithCredentials(request, s3ExpressIdentity, {});
    if (signedRequest.headers["X-Amz-Security-Token"] || signedRequest.headers["x-amz-security-token"]) {
        throw new Error("X-Amz-Security-Token must not be set for s3-express requests.");
    }
    return signedRequest;
};

const defaultErrorHandler = (signingProperties) => (error) => {
    throw error;
};
const defaultSuccessHandler = (httpResponse, signingProperties) => { };
const s3ExpressHttpSigningMiddleware = (config) => (next, context) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
        return next(args);
    }
    const smithyContext = getSmithyContext(context);
    const scheme = smithyContext.selectedHttpAuthScheme;
    if (!scheme) {
        throw new Error(`No HttpAuthScheme was selected: unable to sign request`);
    }
    const { httpAuthOption: { signingProperties = {} }, identity, signer, } = scheme;
    let request;
    if (context.s3ExpressIdentity) {
        request = await signS3Express(context.s3ExpressIdentity, signingProperties, args.request, await config.signer());
    }
    else {
        request = await signer.sign(args.request, identity, signingProperties);
    }
    const output = await next({
        ...args,
        request,
    }).catch((signer.errorHandler || defaultErrorHandler)(signingProperties));
    (signer.successHandler || defaultSuccessHandler)(output.response, signingProperties);
    return output;
};
const getS3ExpressHttpSigningPlugin = (config) => ({
    applyToStack: (clientStack) => {
        clientStack.addRelativeTo(s3ExpressHttpSigningMiddleware(config), httpSigningMiddlewareOptions);
    },
});

const resolveS3Config = (input, { session, }) => {
    const [s3ClientProvider, CreateSessionCommandCtor] = session;
    return {
        ...input,
        forcePathStyle: input.forcePathStyle ?? false,
        useAccelerateEndpoint: input.useAccelerateEndpoint ?? false,
        disableMultiregionAccessPoints: input.disableMultiregionAccessPoints ?? false,
        followRegionRedirects: input.followRegionRedirects ?? false,
        s3ExpressIdentityProvider: input.s3ExpressIdentityProvider ??
            new S3ExpressIdentityProviderImpl(async (key) => s3ClientProvider().send(new CreateSessionCommandCtor({
                Bucket: key,
            }))),
        bucketEndpoint: input.bucketEndpoint ?? false,
    };
};

const THROW_IF_EMPTY_BODY = {
    CopyObjectCommand: true,
    UploadPartCopyCommand: true,
    CompleteMultipartUploadCommand: true,
};
const MAX_BYTES_TO_INSPECT = 3000;
const throw200ExceptionsMiddleware = (config) => (next, context) => async (args) => {
    const result = await next(args);
    const { response } = result;
    if (!HttpResponse.isInstance(response)) {
        return result;
    }
    const { statusCode, body: sourceBody } = response;
    if (statusCode < 200 || statusCode >= 300) {
        return result;
    }
    const isSplittableStream = typeof sourceBody?.stream === "function" ||
        typeof sourceBody?.pipe === "function" ||
        typeof sourceBody?.tee === "function";
    if (!isSplittableStream) {
        return result;
    }
    let bodyCopy = sourceBody;
    let body = sourceBody;
    if (sourceBody && typeof sourceBody === "object" && !(sourceBody instanceof Uint8Array)) {
        [bodyCopy, body] = await splitStream(sourceBody);
    }
    response.body = body;
    const bodyBytes = await collectBody(bodyCopy, {
        streamCollector: async (stream) => {
            return headStream(stream, MAX_BYTES_TO_INSPECT);
        },
    });
    if (typeof bodyCopy?.destroy === "function") {
        bodyCopy.destroy();
    }
    const bodyStringTail = config.utf8Encoder(bodyBytes.subarray(bodyBytes.length - 16));
    if (bodyBytes.length === 0 && THROW_IF_EMPTY_BODY[context.commandName]) {
        const err = new Error("S3 aborted request");
        err.name = "InternalError";
        throw err;
    }
    if (bodyStringTail && bodyStringTail.endsWith("</Error>")) {
        response.statusCode = 400;
    }
    return result;
};
const collectBody = (streamBody = new Uint8Array(), context) => {
    if (streamBody instanceof Uint8Array) {
        return Promise.resolve(streamBody);
    }
    return context.streamCollector(streamBody) || Promise.resolve(new Uint8Array());
};
const throw200ExceptionsMiddlewareOptions = {
    relation: "after",
    toMiddleware: "deserializerMiddleware",
    tags: ["THROW_200_EXCEPTIONS", "S3"],
    name: "throw200ExceptionsMiddleware",
    override: true,
};
const getThrow200ExceptionsPlugin = (config) => ({
    applyToStack: (clientStack) => {
        clientStack.addRelativeTo(throw200ExceptionsMiddleware(config), throw200ExceptionsMiddlewareOptions);
    },
});

const validate = (str) => typeof str === "string" && str.indexOf("arn:") === 0 && str.split(":").length >= 6;

function bucketEndpointMiddleware(options) {
    return (next, context) => async (args) => {
        if (options.bucketEndpoint) {
            const endpoint = context.endpointV2;
            if (endpoint) {
                const bucket = args.input.Bucket;
                if (typeof bucket === "string") {
                    try {
                        const bucketEndpointUrl = new URL(bucket);
                        context.endpointV2 = {
                            ...endpoint,
                            url: bucketEndpointUrl,
                        };
                    }
                    catch (e) {
                        const warning = `@aws-sdk/middleware-sdk-s3: bucketEndpoint=true was set but Bucket=${bucket} could not be parsed as URL.`;
                        if (context.logger?.constructor?.name === "NoOpLogger") {
                            console.warn(warning);
                        }
                        else {
                            context.logger?.warn?.(warning);
                        }
                        throw e;
                    }
                }
            }
        }
        return next(args);
    };
}
const bucketEndpointMiddlewareOptions = {
    name: "bucketEndpointMiddleware",
    override: true,
    relation: "after",
    toMiddleware: "endpointV2Middleware",
};

function validateBucketNameMiddleware({ bucketEndpoint }) {
    return (next) => async (args) => {
        const { input: { Bucket }, } = args;
        if (!bucketEndpoint && typeof Bucket === "string" && !validate(Bucket) && Bucket.indexOf("/") >= 0) {
            const err = new Error(`Bucket name shouldn't contain '/', received '${Bucket}'`);
            err.name = "InvalidBucketName";
            throw err;
        }
        return next({ ...args });
    };
}
const validateBucketNameMiddlewareOptions = {
    step: "initialize",
    tags: ["VALIDATE_BUCKET_NAME"],
    name: "validateBucketNameMiddleware",
    override: true,
};
const getValidateBucketNamePlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(validateBucketNameMiddleware(options), validateBucketNameMiddlewareOptions);
        clientStack.addRelativeTo(bucketEndpointMiddleware(options), bucketEndpointMiddlewareOptions);
    },
});

const DEFAULT_UA_APP_ID = undefined;
function isValidUserAgentAppId(appId) {
    if (appId === undefined) {
        return true;
    }
    return typeof appId === "string" && appId.length <= 50;
}
function resolveUserAgentConfig(input) {
    const normalizedAppIdProvider = normalizeProvider(input.userAgentAppId ?? DEFAULT_UA_APP_ID);
    return {
        ...input,
        customUserAgent: typeof input.customUserAgent === "string" ? [[input.customUserAgent]] : input.customUserAgent,
        userAgentAppId: async () => {
            const appId = await normalizedAppIdProvider();
            if (!isValidUserAgentAppId(appId)) {
                const logger = input.logger?.constructor?.name === "NoOpLogger" || !input.logger ? console : input.logger;
                if (typeof appId !== "string") {
                    logger?.warn("userAgentAppId must be a string or undefined.");
                }
                else if (appId.length > 50) {
                    logger?.warn("The provided userAgentAppId exceeds the maximum length of 50 characters.");
                }
            }
            return appId;
        },
    };
}

class EndpointCache {
    constructor({ size, params }) {
        this.data = new Map();
        this.parameters = [];
        this.capacity = size ?? 50;
        if (params) {
            this.parameters = params;
        }
    }
    get(endpointParams, resolver) {
        const key = this.hash(endpointParams);
        if (key === false) {
            return resolver();
        }
        if (!this.data.has(key)) {
            if (this.data.size > this.capacity + 10) {
                const keys = this.data.keys();
                let i = 0;
                while (true) {
                    const { value, done } = keys.next();
                    this.data.delete(value);
                    if (done || ++i > 10) {
                        break;
                    }
                }
            }
            this.data.set(key, resolver());
        }
        return this.data.get(key);
    }
    size() {
        return this.data.size;
    }
    hash(endpointParams) {
        let buffer = "";
        const { parameters } = this;
        if (parameters.length === 0) {
            return false;
        }
        for (const param of parameters) {
            const val = String(endpointParams[param] ?? "");
            if (val.includes("|;")) {
                return false;
            }
            buffer += val + "|;";
        }
        return buffer;
    }
}

const IP_V4_REGEX = new RegExp(`^(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}$`);
const isIpAddress = (value) => IP_V4_REGEX.test(value) || (value.startsWith("[") && value.endsWith("]"));

const VALID_HOST_LABEL_REGEX = new RegExp(`^(?!.*-$)(?!-)[a-zA-Z0-9-]{1,63}$`);
const isValidHostLabel = (value, allowSubDomains = false) => {
    if (!allowSubDomains) {
        return VALID_HOST_LABEL_REGEX.test(value);
    }
    const labels = value.split(".");
    for (const label of labels) {
        if (!isValidHostLabel(label)) {
            return false;
        }
    }
    return true;
};

const customEndpointFunctions = {};

const debugId = "endpoints";

function toDebugString(input) {
    if (typeof input !== "object" || input == null) {
        return input;
    }
    if ("ref" in input) {
        return `$${toDebugString(input.ref)}`;
    }
    if ("fn" in input) {
        return `${input.fn}(${(input.argv || []).map(toDebugString).join(", ")})`;
    }
    return JSON.stringify(input, null, 2);
}

class EndpointError extends Error {
    constructor(message) {
        super(message);
        this.name = "EndpointError";
    }
}

const booleanEquals = (value1, value2) => value1 === value2;

const getAttrPathList = (path) => {
    const parts = path.split(".");
    const pathList = [];
    for (const part of parts) {
        const squareBracketIndex = part.indexOf("[");
        if (squareBracketIndex !== -1) {
            if (part.indexOf("]") !== part.length - 1) {
                throw new EndpointError(`Path: '${path}' does not end with ']'`);
            }
            const arrayIndex = part.slice(squareBracketIndex + 1, -1);
            if (Number.isNaN(parseInt(arrayIndex))) {
                throw new EndpointError(`Invalid array index: '${arrayIndex}' in path: '${path}'`);
            }
            if (squareBracketIndex !== 0) {
                pathList.push(part.slice(0, squareBracketIndex));
            }
            pathList.push(arrayIndex);
        }
        else {
            pathList.push(part);
        }
    }
    return pathList;
};

const getAttr = (value, path) => getAttrPathList(path).reduce((acc, index) => {
    if (typeof acc !== "object") {
        throw new EndpointError(`Index '${index}' in '${path}' not found in '${JSON.stringify(value)}'`);
    }
    else if (Array.isArray(acc)) {
        return acc[parseInt(index)];
    }
    return acc[index];
}, value);

const isSet = (value) => value != null;

const not = (value) => !value;

const DEFAULT_PORTS = {
    [EndpointURLScheme.HTTP]: 80,
    [EndpointURLScheme.HTTPS]: 443,
};
const parseURL = (value) => {
    const whatwgURL = (() => {
        try {
            if (value instanceof URL) {
                return value;
            }
            if (typeof value === "object" && "hostname" in value) {
                const { hostname, port, protocol = "", path = "", query = {} } = value;
                const url = new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}${path}`);
                url.search = Object.entries(query)
                    .map(([k, v]) => `${k}=${v}`)
                    .join("&");
                return url;
            }
            return new URL(value);
        }
        catch (error) {
            return null;
        }
    })();
    if (!whatwgURL) {
        console.error(`Unable to parse ${JSON.stringify(value)} as a whatwg URL.`);
        return null;
    }
    const urlString = whatwgURL.href;
    const { host, hostname, pathname, protocol, search } = whatwgURL;
    if (search) {
        return null;
    }
    const scheme = protocol.slice(0, -1);
    if (!Object.values(EndpointURLScheme).includes(scheme)) {
        return null;
    }
    const isIp = isIpAddress(hostname);
    const inputContainsDefaultPort = urlString.includes(`${host}:${DEFAULT_PORTS[scheme]}`) ||
        (typeof value === "string" && value.includes(`${host}:${DEFAULT_PORTS[scheme]}`));
    const authority = `${host}${inputContainsDefaultPort ? `:${DEFAULT_PORTS[scheme]}` : ``}`;
    return {
        scheme,
        authority,
        path: pathname,
        normalizedPath: pathname.endsWith("/") ? pathname : `${pathname}/`,
        isIp,
    };
};

const stringEquals = (value1, value2) => value1 === value2;

const substring = (input, start, stop, reverse) => {
    if (start >= stop || input.length < stop) {
        return null;
    }
    if (!reverse) {
        return input.substring(start, stop);
    }
    return input.substring(input.length - stop, input.length - start);
};

const uriEncode = (value) => encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const endpointFunctions = {
    booleanEquals,
    getAttr,
    isSet,
    isValidHostLabel,
    not,
    parseURL,
    stringEquals,
    substring,
    uriEncode,
};

const evaluateTemplate = (template, options) => {
    const evaluatedTemplateArr = [];
    const templateContext = {
        ...options.endpointParams,
        ...options.referenceRecord,
    };
    let currentIndex = 0;
    while (currentIndex < template.length) {
        const openingBraceIndex = template.indexOf("{", currentIndex);
        if (openingBraceIndex === -1) {
            evaluatedTemplateArr.push(template.slice(currentIndex));
            break;
        }
        evaluatedTemplateArr.push(template.slice(currentIndex, openingBraceIndex));
        const closingBraceIndex = template.indexOf("}", openingBraceIndex);
        if (closingBraceIndex === -1) {
            evaluatedTemplateArr.push(template.slice(openingBraceIndex));
            break;
        }
        if (template[openingBraceIndex + 1] === "{" && template[closingBraceIndex + 1] === "}") {
            evaluatedTemplateArr.push(template.slice(openingBraceIndex + 1, closingBraceIndex));
            currentIndex = closingBraceIndex + 2;
        }
        const parameterName = template.substring(openingBraceIndex + 1, closingBraceIndex);
        if (parameterName.includes("#")) {
            const [refName, attrName] = parameterName.split("#");
            evaluatedTemplateArr.push(getAttr(templateContext[refName], attrName));
        }
        else {
            evaluatedTemplateArr.push(templateContext[parameterName]);
        }
        currentIndex = closingBraceIndex + 1;
    }
    return evaluatedTemplateArr.join("");
};

const getReferenceValue = ({ ref }, options) => {
    const referenceRecord = {
        ...options.endpointParams,
        ...options.referenceRecord,
    };
    return referenceRecord[ref];
};

const evaluateExpression = (obj, keyName, options) => {
    if (typeof obj === "string") {
        return evaluateTemplate(obj, options);
    }
    else if (obj["fn"]) {
        return callFunction(obj, options);
    }
    else if (obj["ref"]) {
        return getReferenceValue(obj, options);
    }
    throw new EndpointError(`'${keyName}': ${String(obj)} is not a string, function or reference.`);
};

const callFunction = ({ fn, argv }, options) => {
    const evaluatedArgs = argv.map((arg) => ["boolean", "number"].includes(typeof arg) ? arg : evaluateExpression(arg, "arg", options));
    const fnSegments = fn.split(".");
    if (fnSegments[0] in customEndpointFunctions && fnSegments[1] != null) {
        return customEndpointFunctions[fnSegments[0]][fnSegments[1]](...evaluatedArgs);
    }
    return endpointFunctions[fn](...evaluatedArgs);
};

const evaluateCondition = ({ assign, ...fnArgs }, options) => {
    if (assign && assign in options.referenceRecord) {
        throw new EndpointError(`'${assign}' is already defined in Reference Record.`);
    }
    const value = callFunction(fnArgs, options);
    options.logger?.debug?.(`${debugId} evaluateCondition: ${toDebugString(fnArgs)} = ${toDebugString(value)}`);
    return {
        result: value === "" ? true : !!value,
        ...(assign != null && { toAssign: { name: assign, value } }),
    };
};

const evaluateConditions = (conditions = [], options) => {
    const conditionsReferenceRecord = {};
    for (const condition of conditions) {
        const { result, toAssign } = evaluateCondition(condition, {
            ...options,
            referenceRecord: {
                ...options.referenceRecord,
                ...conditionsReferenceRecord,
            },
        });
        if (!result) {
            return { result };
        }
        if (toAssign) {
            conditionsReferenceRecord[toAssign.name] = toAssign.value;
            options.logger?.debug?.(`${debugId} assign: ${toAssign.name} := ${toDebugString(toAssign.value)}`);
        }
    }
    return { result: true, referenceRecord: conditionsReferenceRecord };
};

const getEndpointHeaders = (headers, options) => Object.entries(headers).reduce((acc, [headerKey, headerVal]) => ({
    ...acc,
    [headerKey]: headerVal.map((headerValEntry) => {
        const processedExpr = evaluateExpression(headerValEntry, "Header value entry", options);
        if (typeof processedExpr !== "string") {
            throw new EndpointError(`Header '${headerKey}' value '${processedExpr}' is not a string`);
        }
        return processedExpr;
    }),
}), {});

const getEndpointProperty = (property, options) => {
    if (Array.isArray(property)) {
        return property.map((propertyEntry) => getEndpointProperty(propertyEntry, options));
    }
    switch (typeof property) {
        case "string":
            return evaluateTemplate(property, options);
        case "object":
            if (property === null) {
                throw new EndpointError(`Unexpected endpoint property: ${property}`);
            }
            return getEndpointProperties(property, options);
        case "boolean":
            return property;
        default:
            throw new EndpointError(`Unexpected endpoint property type: ${typeof property}`);
    }
};

const getEndpointProperties = (properties, options) => Object.entries(properties).reduce((acc, [propertyKey, propertyVal]) => ({
    ...acc,
    [propertyKey]: getEndpointProperty(propertyVal, options),
}), {});

const getEndpointUrl = (endpointUrl, options) => {
    const expression = evaluateExpression(endpointUrl, "Endpoint URL", options);
    if (typeof expression === "string") {
        try {
            return new URL(expression);
        }
        catch (error) {
            console.error(`Failed to construct URL with ${expression}`, error);
            throw error;
        }
    }
    throw new EndpointError(`Endpoint URL must be a string, got ${typeof expression}`);
};

const evaluateEndpointRule = (endpointRule, options) => {
    const { conditions, endpoint } = endpointRule;
    const { result, referenceRecord } = evaluateConditions(conditions, options);
    if (!result) {
        return;
    }
    const endpointRuleOptions = {
        ...options,
        referenceRecord: { ...options.referenceRecord, ...referenceRecord },
    };
    const { url, properties, headers } = endpoint;
    options.logger?.debug?.(`${debugId} Resolving endpoint from template: ${toDebugString(endpoint)}`);
    return {
        ...(headers != undefined && {
            headers: getEndpointHeaders(headers, endpointRuleOptions),
        }),
        ...(properties != undefined && {
            properties: getEndpointProperties(properties, endpointRuleOptions),
        }),
        url: getEndpointUrl(url, endpointRuleOptions),
    };
};

const evaluateErrorRule = (errorRule, options) => {
    const { conditions, error } = errorRule;
    const { result, referenceRecord } = evaluateConditions(conditions, options);
    if (!result) {
        return;
    }
    throw new EndpointError(evaluateExpression(error, "Error", {
        ...options,
        referenceRecord: { ...options.referenceRecord, ...referenceRecord },
    }));
};

const evaluateTreeRule = (treeRule, options) => {
    const { conditions, rules } = treeRule;
    const { result, referenceRecord } = evaluateConditions(conditions, options);
    if (!result) {
        return;
    }
    return evaluateRules(rules, {
        ...options,
        referenceRecord: { ...options.referenceRecord, ...referenceRecord },
    });
};

const evaluateRules = (rules, options) => {
    for (const rule of rules) {
        if (rule.type === "endpoint") {
            const endpointOrUndefined = evaluateEndpointRule(rule, options);
            if (endpointOrUndefined) {
                return endpointOrUndefined;
            }
        }
        else if (rule.type === "error") {
            evaluateErrorRule(rule, options);
        }
        else if (rule.type === "tree") {
            const endpointOrUndefined = evaluateTreeRule(rule, options);
            if (endpointOrUndefined) {
                return endpointOrUndefined;
            }
        }
        else {
            throw new EndpointError(`Unknown endpoint rule: ${rule}`);
        }
    }
    throw new EndpointError(`Rules evaluation failed`);
};

const resolveEndpoint = (ruleSetObject, options) => {
    const { endpointParams, logger } = options;
    const { parameters, rules } = ruleSetObject;
    options.logger?.debug?.(`${debugId} Initial EndpointParams: ${toDebugString(endpointParams)}`);
    const paramsWithDefault = Object.entries(parameters)
        .filter(([, v]) => v.default != null)
        .map(([k, v]) => [k, v.default]);
    if (paramsWithDefault.length > 0) {
        for (const [paramKey, paramDefaultValue] of paramsWithDefault) {
            endpointParams[paramKey] = endpointParams[paramKey] ?? paramDefaultValue;
        }
    }
    const requiredParams = Object.entries(parameters)
        .filter(([, v]) => v.required)
        .map(([k]) => k);
    for (const requiredParam of requiredParams) {
        if (endpointParams[requiredParam] == null) {
            throw new EndpointError(`Missing required parameter: '${requiredParam}'`);
        }
    }
    const endpoint = evaluateRules(rules, { endpointParams, logger, referenceRecord: {} });
    options.logger?.debug?.(`${debugId} Resolved endpoint: ${toDebugString(endpoint)}`);
    return endpoint;
};

const isVirtualHostableS3Bucket = (value, allowSubDomains = false) => {
    if (allowSubDomains) {
        for (const label of value.split(".")) {
            if (!isVirtualHostableS3Bucket(label)) {
                return false;
            }
        }
        return true;
    }
    if (!isValidHostLabel(value)) {
        return false;
    }
    if (value.length < 3 || value.length > 63) {
        return false;
    }
    if (value !== value.toLowerCase()) {
        return false;
    }
    if (isIpAddress(value)) {
        return false;
    }
    return true;
};

const ARN_DELIMITER = ":";
const RESOURCE_DELIMITER = "/";
const parseArn = (value) => {
    const segments = value.split(ARN_DELIMITER);
    if (segments.length < 6)
        return null;
    const [arn, partition, service, region, accountId, ...resourcePath] = segments;
    if (arn !== "arn" || partition === "" || service === "" || resourcePath.join(ARN_DELIMITER) === "")
        return null;
    const resourceId = resourcePath.map((resource) => resource.split(RESOURCE_DELIMITER)).flat();
    return {
        partition,
        service,
        region,
        accountId,
        resourceId,
    };
};

var partitions = [
	{
		id: "aws",
		outputs: {
			dnsSuffix: "amazonaws.com",
			dualStackDnsSuffix: "api.aws",
			implicitGlobalRegion: "us-east-1",
			name: "aws",
			supportsDualStack: true,
			supportsFIPS: true
		},
		regionRegex: "^(us|eu|ap|sa|ca|me|af|il|mx)\\-\\w+\\-\\d+$",
		regions: {
			"af-south-1": {
				description: "Africa (Cape Town)"
			},
			"ap-east-1": {
				description: "Asia Pacific (Hong Kong)"
			},
			"ap-northeast-1": {
				description: "Asia Pacific (Tokyo)"
			},
			"ap-northeast-2": {
				description: "Asia Pacific (Seoul)"
			},
			"ap-northeast-3": {
				description: "Asia Pacific (Osaka)"
			},
			"ap-south-1": {
				description: "Asia Pacific (Mumbai)"
			},
			"ap-south-2": {
				description: "Asia Pacific (Hyderabad)"
			},
			"ap-southeast-1": {
				description: "Asia Pacific (Singapore)"
			},
			"ap-southeast-2": {
				description: "Asia Pacific (Sydney)"
			},
			"ap-southeast-3": {
				description: "Asia Pacific (Jakarta)"
			},
			"ap-southeast-4": {
				description: "Asia Pacific (Melbourne)"
			},
			"ap-southeast-5": {
				description: "Asia Pacific (Malaysia)"
			},
			"ap-southeast-7": {
				description: "Asia Pacific (Thailand)"
			},
			"aws-global": {
				description: "AWS Standard global region"
			},
			"ca-central-1": {
				description: "Canada (Central)"
			},
			"ca-west-1": {
				description: "Canada West (Calgary)"
			},
			"eu-central-1": {
				description: "Europe (Frankfurt)"
			},
			"eu-central-2": {
				description: "Europe (Zurich)"
			},
			"eu-north-1": {
				description: "Europe (Stockholm)"
			},
			"eu-south-1": {
				description: "Europe (Milan)"
			},
			"eu-south-2": {
				description: "Europe (Spain)"
			},
			"eu-west-1": {
				description: "Europe (Ireland)"
			},
			"eu-west-2": {
				description: "Europe (London)"
			},
			"eu-west-3": {
				description: "Europe (Paris)"
			},
			"il-central-1": {
				description: "Israel (Tel Aviv)"
			},
			"me-central-1": {
				description: "Middle East (UAE)"
			},
			"me-south-1": {
				description: "Middle East (Bahrain)"
			},
			"mx-central-1": {
				description: "Mexico (Central)"
			},
			"sa-east-1": {
				description: "South America (Sao Paulo)"
			},
			"us-east-1": {
				description: "US East (N. Virginia)"
			},
			"us-east-2": {
				description: "US East (Ohio)"
			},
			"us-west-1": {
				description: "US West (N. California)"
			},
			"us-west-2": {
				description: "US West (Oregon)"
			}
		}
	},
	{
		id: "aws-cn",
		outputs: {
			dnsSuffix: "amazonaws.com.cn",
			dualStackDnsSuffix: "api.amazonwebservices.com.cn",
			implicitGlobalRegion: "cn-northwest-1",
			name: "aws-cn",
			supportsDualStack: true,
			supportsFIPS: true
		},
		regionRegex: "^cn\\-\\w+\\-\\d+$",
		regions: {
			"aws-cn-global": {
				description: "AWS China global region"
			},
			"cn-north-1": {
				description: "China (Beijing)"
			},
			"cn-northwest-1": {
				description: "China (Ningxia)"
			}
		}
	},
	{
		id: "aws-us-gov",
		outputs: {
			dnsSuffix: "amazonaws.com",
			dualStackDnsSuffix: "api.aws",
			implicitGlobalRegion: "us-gov-west-1",
			name: "aws-us-gov",
			supportsDualStack: true,
			supportsFIPS: true
		},
		regionRegex: "^us\\-gov\\-\\w+\\-\\d+$",
		regions: {
			"aws-us-gov-global": {
				description: "AWS GovCloud (US) global region"
			},
			"us-gov-east-1": {
				description: "AWS GovCloud (US-East)"
			},
			"us-gov-west-1": {
				description: "AWS GovCloud (US-West)"
			}
		}
	},
	{
		id: "aws-iso",
		outputs: {
			dnsSuffix: "c2s.ic.gov",
			dualStackDnsSuffix: "c2s.ic.gov",
			implicitGlobalRegion: "us-iso-east-1",
			name: "aws-iso",
			supportsDualStack: false,
			supportsFIPS: true
		},
		regionRegex: "^us\\-iso\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-global": {
				description: "AWS ISO (US) global region"
			},
			"us-iso-east-1": {
				description: "US ISO East"
			},
			"us-iso-west-1": {
				description: "US ISO WEST"
			}
		}
	},
	{
		id: "aws-iso-b",
		outputs: {
			dnsSuffix: "sc2s.sgov.gov",
			dualStackDnsSuffix: "sc2s.sgov.gov",
			implicitGlobalRegion: "us-isob-east-1",
			name: "aws-iso-b",
			supportsDualStack: false,
			supportsFIPS: true
		},
		regionRegex: "^us\\-isob\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-b-global": {
				description: "AWS ISOB (US) global region"
			},
			"us-isob-east-1": {
				description: "US ISOB East (Ohio)"
			}
		}
	},
	{
		id: "aws-iso-e",
		outputs: {
			dnsSuffix: "cloud.adc-e.uk",
			dualStackDnsSuffix: "cloud.adc-e.uk",
			implicitGlobalRegion: "eu-isoe-west-1",
			name: "aws-iso-e",
			supportsDualStack: false,
			supportsFIPS: true
		},
		regionRegex: "^eu\\-isoe\\-\\w+\\-\\d+$",
		regions: {
			"eu-isoe-west-1": {
				description: "EU ISOE West"
			}
		}
	},
	{
		id: "aws-iso-f",
		outputs: {
			dnsSuffix: "csp.hci.ic.gov",
			dualStackDnsSuffix: "csp.hci.ic.gov",
			implicitGlobalRegion: "us-isof-south-1",
			name: "aws-iso-f",
			supportsDualStack: false,
			supportsFIPS: true
		},
		regionRegex: "^us\\-isof\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-f-global": {
				description: "AWS ISOF global region"
			},
			"us-isof-east-1": {
				description: "US ISOF EAST"
			},
			"us-isof-south-1": {
				description: "US ISOF SOUTH"
			}
		}
	}
];
var version$1 = "1.1";
var partitionsInfo = {
	partitions: partitions,
	version: version$1
};

let selectedPartitionsInfo = partitionsInfo;
const partition = (value) => {
    const { partitions } = selectedPartitionsInfo;
    for (const partition of partitions) {
        const { regions, outputs } = partition;
        for (const [region, regionData] of Object.entries(regions)) {
            if (region === value) {
                return {
                    ...outputs,
                    ...regionData,
                };
            }
        }
    }
    for (const partition of partitions) {
        const { regionRegex, outputs } = partition;
        if (new RegExp(regionRegex).test(value)) {
            return {
                ...outputs,
            };
        }
    }
    const DEFAULT_PARTITION = partitions.find((partition) => partition.id === "aws");
    if (!DEFAULT_PARTITION) {
        throw new Error("Provided region was not found in the partition array or regex," +
            " and default partition with id 'aws' doesn't exist.");
    }
    return {
        ...DEFAULT_PARTITION.outputs,
    };
};

const awsEndpointFunctions = {
    isVirtualHostableS3Bucket: isVirtualHostableS3Bucket,
    parseArn: parseArn,
    partition: partition,
};
customEndpointFunctions.aws = awsEndpointFunctions;

const ACCOUNT_ID_ENDPOINT_REGEX = /\d{12}\.ddb/;
async function checkFeatures(context, config, args) {
    const request = args.request;
    if (request?.headers?.["smithy-protocol"] === "rpc-v2-cbor") {
        setFeature$1(context, "PROTOCOL_RPC_V2_CBOR", "M");
    }
    if (typeof config.retryStrategy === "function") {
        const retryStrategy = await config.retryStrategy();
        if (typeof retryStrategy.acquireInitialRetryToken === "function") {
            if (retryStrategy.constructor?.name?.includes("Adaptive")) {
                setFeature$1(context, "RETRY_MODE_ADAPTIVE", "F");
            }
            else {
                setFeature$1(context, "RETRY_MODE_STANDARD", "E");
            }
        }
        else {
            setFeature$1(context, "RETRY_MODE_LEGACY", "D");
        }
    }
    if (typeof config.accountIdEndpointMode === "function") {
        const endpointV2 = context.endpointV2;
        if (String(endpointV2?.url?.hostname).match(ACCOUNT_ID_ENDPOINT_REGEX)) {
            setFeature$1(context, "ACCOUNT_ID_ENDPOINT", "O");
        }
        switch (await config.accountIdEndpointMode?.()) {
            case "disabled":
                setFeature$1(context, "ACCOUNT_ID_MODE_DISABLED", "Q");
                break;
            case "preferred":
                setFeature$1(context, "ACCOUNT_ID_MODE_PREFERRED", "P");
                break;
            case "required":
                setFeature$1(context, "ACCOUNT_ID_MODE_REQUIRED", "R");
                break;
        }
    }
    const identity = context.__smithy_context?.selectedHttpAuthScheme?.identity;
    if (identity?.$source) {
        const credentials = identity;
        if (credentials.accountId) {
            setFeature$1(context, "RESOLVED_ACCOUNT_ID", "T");
        }
        for (const [key, value] of Object.entries(credentials.$source ?? {})) {
            setFeature$1(context, key, value);
        }
    }
}

const USER_AGENT = "user-agent";
const X_AMZ_USER_AGENT = "x-amz-user-agent";
const SPACE = " ";
const UA_NAME_SEPARATOR = "/";
const UA_NAME_ESCAPE_REGEX = /[^\!\$\%\&\'\*\+\-\.\^\_\`\|\~\d\w]/g;
const UA_VALUE_ESCAPE_REGEX = /[^\!\$\%\&\'\*\+\-\.\^\_\`\|\~\d\w\#]/g;
const UA_ESCAPE_CHAR = "-";

const BYTE_LIMIT = 1024;
function encodeFeatures(features) {
    let buffer = "";
    for (const key in features) {
        const val = features[key];
        if (buffer.length + val.length + 1 <= BYTE_LIMIT) {
            if (buffer.length) {
                buffer += "," + val;
            }
            else {
                buffer += val;
            }
            continue;
        }
        break;
    }
    return buffer;
}

const userAgentMiddleware = (options) => (next, context) => async (args) => {
    const { request } = args;
    if (!HttpRequest.isInstance(request)) {
        return next(args);
    }
    const { headers } = request;
    const userAgent = context?.userAgent?.map(escapeUserAgent) || [];
    const defaultUserAgent = (await options.defaultUserAgentProvider()).map(escapeUserAgent);
    await checkFeatures(context, options, args);
    const awsContext = context;
    defaultUserAgent.push(`m/${encodeFeatures(Object.assign({}, context.__smithy_context?.features, awsContext.__aws_sdk_context?.features))}`);
    const customUserAgent = options?.customUserAgent?.map(escapeUserAgent) || [];
    const appId = await options.userAgentAppId();
    if (appId) {
        defaultUserAgent.push(escapeUserAgent([`app/${appId}`]));
    }
    const sdkUserAgentValue = ([])
        .concat([...defaultUserAgent, ...userAgent, ...customUserAgent])
        .join(SPACE);
    const normalUAValue = [
        ...defaultUserAgent.filter((section) => section.startsWith("aws-sdk-")),
        ...customUserAgent,
    ].join(SPACE);
    if (options.runtime !== "browser") {
        if (normalUAValue) {
            headers[X_AMZ_USER_AGENT] = headers[X_AMZ_USER_AGENT]
                ? `${headers[USER_AGENT]} ${normalUAValue}`
                : normalUAValue;
        }
        headers[USER_AGENT] = sdkUserAgentValue;
    }
    else {
        headers[X_AMZ_USER_AGENT] = sdkUserAgentValue;
    }
    return next({
        ...args,
        request,
    });
};
const escapeUserAgent = (userAgentPair) => {
    const name = userAgentPair[0]
        .split(UA_NAME_SEPARATOR)
        .map((part) => part.replace(UA_NAME_ESCAPE_REGEX, UA_ESCAPE_CHAR))
        .join(UA_NAME_SEPARATOR);
    const version = userAgentPair[1]?.replace(UA_VALUE_ESCAPE_REGEX, UA_ESCAPE_CHAR);
    const prefixSeparatorIndex = name.indexOf(UA_NAME_SEPARATOR);
    const prefix = name.substring(0, prefixSeparatorIndex);
    let uaName = name.substring(prefixSeparatorIndex + 1);
    if (prefix === "api") {
        uaName = uaName.toLowerCase();
    }
    return [prefix, uaName, version]
        .filter((item) => item && item.length > 0)
        .reduce((acc, item, index) => {
        switch (index) {
            case 0:
                return item;
            case 1:
                return `${acc}/${item}`;
            default:
                return `${acc}#${item}`;
        }
    }, "");
};
const getUserAgentMiddlewareOptions = {
    name: "getUserAgentMiddleware",
    step: "build",
    priority: "low",
    tags: ["SET_USER_AGENT", "USER_AGENT"],
    override: true,
};
const getUserAgentPlugin = (config) => ({
    applyToStack: (clientStack) => {
        clientStack.add(userAgentMiddleware(config), getUserAgentMiddlewareOptions);
    },
});

const ENV_USE_DUALSTACK_ENDPOINT = "AWS_USE_DUALSTACK_ENDPOINT";
const CONFIG_USE_DUALSTACK_ENDPOINT = "use_dualstack_endpoint";
const NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => booleanSelector(env, ENV_USE_DUALSTACK_ENDPOINT, SelectorType.ENV),
    configFileSelector: (profile) => booleanSelector(profile, CONFIG_USE_DUALSTACK_ENDPOINT, SelectorType.CONFIG),
    default: false,
};

const ENV_USE_FIPS_ENDPOINT = "AWS_USE_FIPS_ENDPOINT";
const CONFIG_USE_FIPS_ENDPOINT = "use_fips_endpoint";
const NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => booleanSelector(env, ENV_USE_FIPS_ENDPOINT, SelectorType.ENV),
    configFileSelector: (profile) => booleanSelector(profile, CONFIG_USE_FIPS_ENDPOINT, SelectorType.CONFIG),
    default: false,
};

const REGION_ENV_NAME = "AWS_REGION";
const REGION_INI_NAME = "region";
const NODE_REGION_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => env[REGION_ENV_NAME],
    configFileSelector: (profile) => profile[REGION_INI_NAME],
    default: () => {
        throw new Error("Region is missing");
    },
};
const NODE_REGION_CONFIG_FILE_OPTIONS = {
    preferredFile: "credentials",
};

const isFipsRegion = (region) => typeof region === "string" && (region.startsWith("fips-") || region.endsWith("-fips"));

const getRealRegion = (region) => isFipsRegion(region)
    ? ["fips-aws-global", "aws-fips"].includes(region)
        ? "us-east-1"
        : region.replace(/fips-(dkr-|prod-)?|-fips/, "")
    : region;

const resolveRegionConfig = (input) => {
    const { region, useFipsEndpoint } = input;
    if (!region) {
        throw new Error("Region is missing");
    }
    return {
        ...input,
        region: async () => {
            if (typeof region === "string") {
                return getRealRegion(region);
            }
            const providedRegion = await region();
            return getRealRegion(providedRegion);
        },
        useFipsEndpoint: async () => {
            const providedRegion = typeof region === "string" ? region : await region();
            if (isFipsRegion(providedRegion)) {
                return true;
            }
            return typeof useFipsEndpoint !== "function" ? Promise.resolve(!!useFipsEndpoint) : useFipsEndpoint();
        },
    };
};

const resolveEventStreamSerdeConfig = (input) => ({
    ...input,
    eventStreamMarshaller: input.eventStreamSerdeProvider(input),
});

const CONTENT_LENGTH_HEADER = "content-length";
function contentLengthMiddleware(bodyLengthChecker) {
    return (next) => async (args) => {
        const request = args.request;
        if (HttpRequest.isInstance(request)) {
            const { body, headers } = request;
            if (body &&
                Object.keys(headers)
                    .map((str) => str.toLowerCase())
                    .indexOf(CONTENT_LENGTH_HEADER) === -1) {
                try {
                    const length = bodyLengthChecker(body);
                    request.headers = {
                        ...request.headers,
                        [CONTENT_LENGTH_HEADER]: String(length),
                    };
                }
                catch (error) {
                }
            }
        }
        return next({
            ...args,
            request,
        });
    };
}
const contentLengthMiddlewareOptions = {
    step: "build",
    tags: ["SET_CONTENT_LENGTH", "CONTENT_LENGTH"],
    name: "contentLengthMiddleware",
    override: true,
};
const getContentLengthPlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(contentLengthMiddleware(options.bodyLengthChecker), contentLengthMiddlewareOptions);
    },
});

const resolveParamsForS3 = async (endpointParams) => {
    const bucket = endpointParams?.Bucket || "";
    if (typeof endpointParams.Bucket === "string") {
        endpointParams.Bucket = bucket.replace(/#/g, encodeURIComponent("#")).replace(/\?/g, encodeURIComponent("?"));
    }
    if (isArnBucketName(bucket)) {
        if (endpointParams.ForcePathStyle === true) {
            throw new Error("Path-style addressing cannot be used with ARN buckets");
        }
    }
    else if (!isDnsCompatibleBucketName(bucket) ||
        (bucket.indexOf(".") !== -1 && !String(endpointParams.Endpoint).startsWith("http:")) ||
        bucket.toLowerCase() !== bucket ||
        bucket.length < 3) {
        endpointParams.ForcePathStyle = true;
    }
    if (endpointParams.DisableMultiRegionAccessPoints) {
        endpointParams.disableMultiRegionAccessPoints = true;
        endpointParams.DisableMRAP = true;
    }
    return endpointParams;
};
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9\.\-]{1,61}[a-z0-9]$/;
const IP_ADDRESS_PATTERN = /(\d+\.){3}\d+/;
const DOTS_PATTERN = /\.\./;
const isDnsCompatibleBucketName = (bucketName) => DOMAIN_PATTERN.test(bucketName) && !IP_ADDRESS_PATTERN.test(bucketName) && !DOTS_PATTERN.test(bucketName);
const isArnBucketName = (bucketName) => {
    const [arn, partition, service, , , bucket] = bucketName.split(":");
    const isArn = arn === "arn" && bucketName.split(":").length >= 6;
    const isValidArn = Boolean(isArn && partition && service && bucket);
    if (isArn && !isValidArn) {
        throw new Error(`Invalid ARN: ${bucketName} was an invalid ARN.`);
    }
    return isValidArn;
};

const createConfigValueProvider = (configKey, canonicalEndpointParamKey, config) => {
    const configProvider = async () => {
        const configValue = config[configKey] ?? config[canonicalEndpointParamKey];
        if (typeof configValue === "function") {
            return configValue();
        }
        return configValue;
    };
    if (configKey === "credentialScope" || canonicalEndpointParamKey === "CredentialScope") {
        return async () => {
            const credentials = typeof config.credentials === "function" ? await config.credentials() : config.credentials;
            const configValue = credentials?.credentialScope ?? credentials?.CredentialScope;
            return configValue;
        };
    }
    if (configKey === "accountId" || canonicalEndpointParamKey === "AccountId") {
        return async () => {
            const credentials = typeof config.credentials === "function" ? await config.credentials() : config.credentials;
            const configValue = credentials?.accountId ?? credentials?.AccountId;
            return configValue;
        };
    }
    if (configKey === "endpoint" || canonicalEndpointParamKey === "endpoint") {
        return async () => {
            const endpoint = await configProvider();
            if (endpoint && typeof endpoint === "object") {
                if ("url" in endpoint) {
                    return endpoint.url.href;
                }
                if ("hostname" in endpoint) {
                    const { protocol, hostname, port, path } = endpoint;
                    return `${protocol}//${hostname}${port ? ":" + port : ""}${path}`;
                }
            }
            return endpoint;
        };
    }
    return configProvider;
};

function getSelectorName(functionString) {
    try {
        const constants = new Set(Array.from(functionString.match(/([A-Z_]){3,}/g) ?? []));
        constants.delete("CONFIG");
        constants.delete("CONFIG_PREFIX_SEPARATOR");
        constants.delete("ENV");
        return [...constants].join(", ");
    }
    catch (e) {
        return functionString;
    }
}

const fromEnv$1 = (envVarSelector, logger) => async () => {
    try {
        const config = envVarSelector(process.env);
        if (config === undefined) {
            throw new Error();
        }
        return config;
    }
    catch (e) {
        throw new CredentialsProviderError(e.message || `Not found in ENV: ${getSelectorName(envVarSelector.toString())}`, { logger });
    }
};

const homeDirCache = {};
const getHomeDirCacheKey = () => {
    if (process && process.geteuid) {
        return `${process.geteuid()}`;
    }
    return "DEFAULT";
};
const getHomeDir = () => {
    const { HOME, USERPROFILE, HOMEPATH, HOMEDRIVE = `C:${sep}` } = process.env;
    if (HOME)
        return HOME;
    if (USERPROFILE)
        return USERPROFILE;
    if (HOMEPATH)
        return `${HOMEDRIVE}${HOMEPATH}`;
    const homeDirCacheKey = getHomeDirCacheKey();
    if (!homeDirCache[homeDirCacheKey])
        homeDirCache[homeDirCacheKey] = homedir();
    return homeDirCache[homeDirCacheKey];
};

const ENV_PROFILE = "AWS_PROFILE";
const DEFAULT_PROFILE = "default";
const getProfileName = (init) => init.profile || process.env[ENV_PROFILE] || DEFAULT_PROFILE;

const getSSOTokenFilepath = (id) => {
    const hasher = createHash("sha1");
    const cacheName = hasher.update(id).digest("hex");
    return join(getHomeDir(), ".aws", "sso", "cache", `${cacheName}.json`);
};

const { readFile: readFile$1 } = promises;
const getSSOTokenFromFile = async (id) => {
    const ssoTokenFilepath = getSSOTokenFilepath(id);
    const ssoTokenText = await readFile$1(ssoTokenFilepath, "utf8");
    return JSON.parse(ssoTokenText);
};

const getConfigData = (data) => Object.entries(data)
    .filter(([key]) => {
    const indexOfSeparator = key.indexOf(CONFIG_PREFIX_SEPARATOR);
    if (indexOfSeparator === -1) {
        return false;
    }
    return Object.values(IniSectionType).includes(key.substring(0, indexOfSeparator));
})
    .reduce((acc, [key, value]) => {
    const indexOfSeparator = key.indexOf(CONFIG_PREFIX_SEPARATOR);
    const updatedKey = key.substring(0, indexOfSeparator) === IniSectionType.PROFILE ? key.substring(indexOfSeparator + 1) : key;
    acc[updatedKey] = value;
    return acc;
}, {
    ...(data.default && { default: data.default }),
});

const ENV_CONFIG_PATH = "AWS_CONFIG_FILE";
const getConfigFilepath = () => process.env[ENV_CONFIG_PATH] || join(getHomeDir(), ".aws", "config");

const ENV_CREDENTIALS_PATH = "AWS_SHARED_CREDENTIALS_FILE";
const getCredentialsFilepath = () => process.env[ENV_CREDENTIALS_PATH] || join(getHomeDir(), ".aws", "credentials");

const prefixKeyRegex = /^([\w-]+)\s(["'])?([\w-@\+\.%:/]+)\2$/;
const profileNameBlockList = ["__proto__", "profile __proto__"];
const parseIni = (iniData) => {
    const map = {};
    let currentSection;
    let currentSubSection;
    for (const iniLine of iniData.split(/\r?\n/)) {
        const trimmedLine = iniLine.split(/(^|\s)[;#]/)[0].trim();
        const isSection = trimmedLine[0] === "[" && trimmedLine[trimmedLine.length - 1] === "]";
        if (isSection) {
            currentSection = undefined;
            currentSubSection = undefined;
            const sectionName = trimmedLine.substring(1, trimmedLine.length - 1);
            const matches = prefixKeyRegex.exec(sectionName);
            if (matches) {
                const [, prefix, , name] = matches;
                if (Object.values(IniSectionType).includes(prefix)) {
                    currentSection = [prefix, name].join(CONFIG_PREFIX_SEPARATOR);
                }
            }
            else {
                currentSection = sectionName;
            }
            if (profileNameBlockList.includes(sectionName)) {
                throw new Error(`Found invalid profile name "${sectionName}"`);
            }
        }
        else if (currentSection) {
            const indexOfEqualsSign = trimmedLine.indexOf("=");
            if (![0, -1].includes(indexOfEqualsSign)) {
                const [name, value] = [
                    trimmedLine.substring(0, indexOfEqualsSign).trim(),
                    trimmedLine.substring(indexOfEqualsSign + 1).trim(),
                ];
                if (value === "") {
                    currentSubSection = name;
                }
                else {
                    if (currentSubSection && iniLine.trimStart() === iniLine) {
                        currentSubSection = undefined;
                    }
                    map[currentSection] = map[currentSection] || {};
                    const key = currentSubSection ? [currentSubSection, name].join(CONFIG_PREFIX_SEPARATOR) : name;
                    map[currentSection][key] = value;
                }
            }
        }
    }
    return map;
};

const { readFile } = promises;
const filePromisesHash = {};
const slurpFile = (path, options) => {
    if (!filePromisesHash[path] || options?.ignoreCache) {
        filePromisesHash[path] = readFile(path, "utf8");
    }
    return filePromisesHash[path];
};

const swallowError$1 = () => ({});
const CONFIG_PREFIX_SEPARATOR = ".";
const loadSharedConfigFiles = async (init = {}) => {
    const { filepath = getCredentialsFilepath(), configFilepath = getConfigFilepath() } = init;
    const homeDir = getHomeDir();
    const relativeHomeDirPrefix = "~/";
    let resolvedFilepath = filepath;
    if (filepath.startsWith(relativeHomeDirPrefix)) {
        resolvedFilepath = join(homeDir, filepath.slice(2));
    }
    let resolvedConfigFilepath = configFilepath;
    if (configFilepath.startsWith(relativeHomeDirPrefix)) {
        resolvedConfigFilepath = join(homeDir, configFilepath.slice(2));
    }
    const parsedFiles = await Promise.all([
        slurpFile(resolvedConfigFilepath, {
            ignoreCache: init.ignoreCache,
        })
            .then(parseIni)
            .then(getConfigData)
            .catch(swallowError$1),
        slurpFile(resolvedFilepath, {
            ignoreCache: init.ignoreCache,
        })
            .then(parseIni)
            .catch(swallowError$1),
    ]);
    return {
        configFile: parsedFiles[0],
        credentialsFile: parsedFiles[1],
    };
};

const getSsoSessionData = (data) => Object.entries(data)
    .filter(([key]) => key.startsWith(IniSectionType.SSO_SESSION + CONFIG_PREFIX_SEPARATOR))
    .reduce((acc, [key, value]) => ({ ...acc, [key.substring(key.indexOf(CONFIG_PREFIX_SEPARATOR) + 1)]: value }), {});

const swallowError = () => ({});
const loadSsoSessionData = async (init = {}) => slurpFile(init.configFilepath ?? getConfigFilepath())
    .then(parseIni)
    .then(getSsoSessionData)
    .catch(swallowError);

const mergeConfigFiles = (...files) => {
    const merged = {};
    for (const file of files) {
        for (const [key, values] of Object.entries(file)) {
            if (merged[key] !== undefined) {
                Object.assign(merged[key], values);
            }
            else {
                merged[key] = values;
            }
        }
    }
    return merged;
};

const parseKnownFiles = async (init) => {
    const parsedFiles = await loadSharedConfigFiles(init);
    return mergeConfigFiles(parsedFiles.configFile, parsedFiles.credentialsFile);
};

const fromSharedConfigFiles = (configSelector, { preferredFile = "config", ...init } = {}) => async () => {
    const profile = getProfileName(init);
    const { configFile, credentialsFile } = await loadSharedConfigFiles(init);
    const profileFromCredentials = credentialsFile[profile] || {};
    const profileFromConfig = configFile[profile] || {};
    const mergedProfile = preferredFile === "config"
        ? { ...profileFromCredentials, ...profileFromConfig }
        : { ...profileFromConfig, ...profileFromCredentials };
    try {
        const cfgFile = preferredFile === "config" ? configFile : credentialsFile;
        const configValue = configSelector(mergedProfile, cfgFile);
        if (configValue === undefined) {
            throw new Error();
        }
        return configValue;
    }
    catch (e) {
        throw new CredentialsProviderError(e.message || `Not found in config files w/ profile [${profile}]: ${getSelectorName(configSelector.toString())}`, { logger: init.logger });
    }
};

const isFunction = (func) => typeof func === "function";
const fromStatic = (defaultValue) => isFunction(defaultValue) ? async () => await defaultValue() : fromStatic$1(defaultValue);

const loadConfig = ({ environmentVariableSelector, configFileSelector, default: defaultValue }, configuration = {}) => memoize(chain(fromEnv$1(environmentVariableSelector), fromSharedConfigFiles(configFileSelector, configuration), fromStatic(defaultValue)));

const ENV_ENDPOINT_URL = "AWS_ENDPOINT_URL";
const CONFIG_ENDPOINT_URL = "endpoint_url";
const getEndpointUrlConfig = (serviceId) => ({
    environmentVariableSelector: (env) => {
        const serviceSuffixParts = serviceId.split(" ").map((w) => w.toUpperCase());
        const serviceEndpointUrl = env[[ENV_ENDPOINT_URL, ...serviceSuffixParts].join("_")];
        if (serviceEndpointUrl)
            return serviceEndpointUrl;
        const endpointUrl = env[ENV_ENDPOINT_URL];
        if (endpointUrl)
            return endpointUrl;
        return undefined;
    },
    configFileSelector: (profile, config) => {
        if (config && profile.services) {
            const servicesSection = config[["services", profile.services].join(CONFIG_PREFIX_SEPARATOR)];
            if (servicesSection) {
                const servicePrefixParts = serviceId.split(" ").map((w) => w.toLowerCase());
                const endpointUrl = servicesSection[[servicePrefixParts.join("_"), CONFIG_ENDPOINT_URL].join(CONFIG_PREFIX_SEPARATOR)];
                if (endpointUrl)
                    return endpointUrl;
            }
        }
        const endpointUrl = profile[CONFIG_ENDPOINT_URL];
        if (endpointUrl)
            return endpointUrl;
        return undefined;
    },
    default: undefined,
});

const getEndpointFromConfig = async (serviceId) => loadConfig(getEndpointUrlConfig(serviceId ?? ""))();

function parseQueryString(querystring) {
    const query = {};
    querystring = querystring.replace(/^\?/, "");
    if (querystring) {
        for (const pair of querystring.split("&")) {
            let [key, value = null] = pair.split("=");
            key = decodeURIComponent(key);
            if (value) {
                value = decodeURIComponent(value);
            }
            if (!(key in query)) {
                query[key] = value;
            }
            else if (Array.isArray(query[key])) {
                query[key].push(value);
            }
            else {
                query[key] = [query[key], value];
            }
        }
    }
    return query;
}

const parseUrl = (url) => {
    if (typeof url === "string") {
        return parseUrl(new URL(url));
    }
    const { hostname, pathname, port, protocol, search } = url;
    let query;
    if (search) {
        query = parseQueryString(search);
    }
    return {
        hostname,
        port: port ? parseInt(port) : undefined,
        protocol,
        path: pathname,
        query,
    };
};

const toEndpointV1 = (endpoint) => {
    if (typeof endpoint === "object") {
        if ("url" in endpoint) {
            return parseUrl(endpoint.url);
        }
        return endpoint;
    }
    return parseUrl(endpoint);
};

const getEndpointFromInstructions = async (commandInput, instructionsSupplier, clientConfig, context) => {
    if (!clientConfig.endpoint) {
        let endpointFromConfig;
        if (clientConfig.serviceConfiguredEndpoint) {
            endpointFromConfig = await clientConfig.serviceConfiguredEndpoint();
        }
        else {
            endpointFromConfig = await getEndpointFromConfig(clientConfig.serviceId);
        }
        if (endpointFromConfig) {
            clientConfig.endpoint = () => Promise.resolve(toEndpointV1(endpointFromConfig));
        }
    }
    const endpointParams = await resolveParams(commandInput, instructionsSupplier, clientConfig);
    if (typeof clientConfig.endpointProvider !== "function") {
        throw new Error("config.endpointProvider is not set.");
    }
    const endpoint = clientConfig.endpointProvider(endpointParams, context);
    return endpoint;
};
const resolveParams = async (commandInput, instructionsSupplier, clientConfig) => {
    const endpointParams = {};
    const instructions = instructionsSupplier?.getEndpointParameterInstructions?.() || {};
    for (const [name, instruction] of Object.entries(instructions)) {
        switch (instruction.type) {
            case "staticContextParams":
                endpointParams[name] = instruction.value;
                break;
            case "contextParams":
                endpointParams[name] = commandInput[instruction.name];
                break;
            case "clientContextParams":
            case "builtInParams":
                endpointParams[name] = await createConfigValueProvider(instruction.name, name, clientConfig)();
                break;
            case "operationContextParams":
                endpointParams[name] = instruction.get(commandInput);
                break;
            default:
                throw new Error("Unrecognized endpoint parameter instruction: " + JSON.stringify(instruction));
        }
    }
    if (Object.keys(instructions).length === 0) {
        Object.assign(endpointParams, clientConfig);
    }
    if (String(clientConfig.serviceId).toLowerCase() === "s3") {
        await resolveParamsForS3(endpointParams);
    }
    return endpointParams;
};

const endpointMiddleware = ({ config, instructions, }) => {
    return (next, context) => async (args) => {
        if (config.endpoint) {
            setFeature(context, "ENDPOINT_OVERRIDE", "N");
        }
        const endpoint = await getEndpointFromInstructions(args.input, {
            getEndpointParameterInstructions() {
                return instructions;
            },
        }, { ...config }, context);
        context.endpointV2 = endpoint;
        context.authSchemes = endpoint.properties?.authSchemes;
        const authScheme = context.authSchemes?.[0];
        if (authScheme) {
            context["signing_region"] = authScheme.signingRegion;
            context["signing_service"] = authScheme.signingName;
            const smithyContext = getSmithyContext(context);
            const httpAuthOption = smithyContext?.selectedHttpAuthScheme?.httpAuthOption;
            if (httpAuthOption) {
                httpAuthOption.signingProperties = Object.assign(httpAuthOption.signingProperties || {}, {
                    signing_region: authScheme.signingRegion,
                    signingRegion: authScheme.signingRegion,
                    signing_service: authScheme.signingName,
                    signingName: authScheme.signingName,
                    signingRegionSet: authScheme.signingRegionSet,
                }, authScheme.properties);
            }
        }
        return next({
            ...args,
        });
    };
};

const endpointMiddlewareOptions = {
    step: "serialize",
    tags: ["ENDPOINT_PARAMETERS", "ENDPOINT_V2", "ENDPOINT"],
    name: "endpointV2Middleware",
    override: true,
    relation: "before",
    toMiddleware: serializerMiddlewareOption.name,
};
const getEndpointPlugin = (config, instructions) => ({
    applyToStack: (clientStack) => {
        clientStack.addRelativeTo(endpointMiddleware({
            config,
            instructions,
        }), endpointMiddlewareOptions);
    },
});

const resolveEndpointConfig = (input) => {
    const tls = input.tls ?? true;
    const { endpoint } = input;
    const customEndpointProvider = endpoint != null ? async () => toEndpointV1(await normalizeProvider$1(endpoint)()) : undefined;
    const isCustomEndpoint = !!endpoint;
    const resolvedConfig = {
        ...input,
        endpoint: customEndpointProvider,
        tls,
        isCustomEndpoint,
        useDualstackEndpoint: normalizeProvider$1(input.useDualstackEndpoint ?? false),
        useFipsEndpoint: normalizeProvider$1(input.useFipsEndpoint ?? false),
    };
    let configuredEndpointPromise = undefined;
    resolvedConfig.serviceConfiguredEndpoint = async () => {
        if (input.serviceId && !configuredEndpointPromise) {
            configuredEndpointPromise = getEndpointFromConfig(input.serviceId);
        }
        return configuredEndpointPromise;
    };
    return resolvedConfig;
};

var RETRY_MODES;
(function (RETRY_MODES) {
    RETRY_MODES["STANDARD"] = "standard";
    RETRY_MODES["ADAPTIVE"] = "adaptive";
})(RETRY_MODES || (RETRY_MODES = {}));
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_MODE = RETRY_MODES.STANDARD;

const THROTTLING_ERROR_CODES = [
    "BandwidthLimitExceeded",
    "EC2ThrottledException",
    "LimitExceededException",
    "PriorRequestNotComplete",
    "ProvisionedThroughputExceededException",
    "RequestLimitExceeded",
    "RequestThrottled",
    "RequestThrottledException",
    "SlowDown",
    "ThrottledException",
    "Throttling",
    "ThrottlingException",
    "TooManyRequestsException",
    "TransactionInProgressException",
];
const TRANSIENT_ERROR_CODES = ["TimeoutError", "RequestTimeout", "RequestTimeoutException"];
const TRANSIENT_ERROR_STATUS_CODES = [500, 502, 503, 504];
const NODEJS_TIMEOUT_ERROR_CODES = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"];

const isClockSkewCorrectedError = (error) => error.$metadata?.clockSkewCorrected;
const isThrottlingError = (error) => error.$metadata?.httpStatusCode === 429 ||
    THROTTLING_ERROR_CODES.includes(error.name) ||
    error.$retryable?.throttling == true;
const isTransientError = (error, depth = 0) => isClockSkewCorrectedError(error) ||
    TRANSIENT_ERROR_CODES.includes(error.name) ||
    NODEJS_TIMEOUT_ERROR_CODES.includes(error?.code || "") ||
    TRANSIENT_ERROR_STATUS_CODES.includes(error.$metadata?.httpStatusCode || 0) ||
    (error.cause !== undefined && depth <= 10 && isTransientError(error.cause, depth + 1));
const isServerError = (error) => {
    if (error.$metadata?.httpStatusCode !== undefined) {
        const statusCode = error.$metadata.httpStatusCode;
        if (500 <= statusCode && statusCode <= 599 && !isTransientError(error)) {
            return true;
        }
        return false;
    }
    return false;
};

class DefaultRateLimiter {
    constructor(options) {
        this.currentCapacity = 0;
        this.enabled = false;
        this.lastMaxRate = 0;
        this.measuredTxRate = 0;
        this.requestCount = 0;
        this.lastTimestamp = 0;
        this.timeWindow = 0;
        this.beta = options?.beta ?? 0.7;
        this.minCapacity = options?.minCapacity ?? 1;
        this.minFillRate = options?.minFillRate ?? 0.5;
        this.scaleConstant = options?.scaleConstant ?? 0.4;
        this.smooth = options?.smooth ?? 0.8;
        const currentTimeInSeconds = this.getCurrentTimeInSeconds();
        this.lastThrottleTime = currentTimeInSeconds;
        this.lastTxRateBucket = Math.floor(this.getCurrentTimeInSeconds());
        this.fillRate = this.minFillRate;
        this.maxCapacity = this.minCapacity;
    }
    getCurrentTimeInSeconds() {
        return Date.now() / 1000;
    }
    async getSendToken() {
        return this.acquireTokenBucket(1);
    }
    async acquireTokenBucket(amount) {
        if (!this.enabled) {
            return;
        }
        this.refillTokenBucket();
        if (amount > this.currentCapacity) {
            const delay = ((amount - this.currentCapacity) / this.fillRate) * 1000;
            await new Promise((resolve) => DefaultRateLimiter.setTimeoutFn(resolve, delay));
        }
        this.currentCapacity = this.currentCapacity - amount;
    }
    refillTokenBucket() {
        const timestamp = this.getCurrentTimeInSeconds();
        if (!this.lastTimestamp) {
            this.lastTimestamp = timestamp;
            return;
        }
        const fillAmount = (timestamp - this.lastTimestamp) * this.fillRate;
        this.currentCapacity = Math.min(this.maxCapacity, this.currentCapacity + fillAmount);
        this.lastTimestamp = timestamp;
    }
    updateClientSendingRate(response) {
        let calculatedRate;
        this.updateMeasuredRate();
        if (isThrottlingError(response)) {
            const rateToUse = !this.enabled ? this.measuredTxRate : Math.min(this.measuredTxRate, this.fillRate);
            this.lastMaxRate = rateToUse;
            this.calculateTimeWindow();
            this.lastThrottleTime = this.getCurrentTimeInSeconds();
            calculatedRate = this.cubicThrottle(rateToUse);
            this.enableTokenBucket();
        }
        else {
            this.calculateTimeWindow();
            calculatedRate = this.cubicSuccess(this.getCurrentTimeInSeconds());
        }
        const newRate = Math.min(calculatedRate, 2 * this.measuredTxRate);
        this.updateTokenBucketRate(newRate);
    }
    calculateTimeWindow() {
        this.timeWindow = this.getPrecise(Math.pow((this.lastMaxRate * (1 - this.beta)) / this.scaleConstant, 1 / 3));
    }
    cubicThrottle(rateToUse) {
        return this.getPrecise(rateToUse * this.beta);
    }
    cubicSuccess(timestamp) {
        return this.getPrecise(this.scaleConstant * Math.pow(timestamp - this.lastThrottleTime - this.timeWindow, 3) + this.lastMaxRate);
    }
    enableTokenBucket() {
        this.enabled = true;
    }
    updateTokenBucketRate(newRate) {
        this.refillTokenBucket();
        this.fillRate = Math.max(newRate, this.minFillRate);
        this.maxCapacity = Math.max(newRate, this.minCapacity);
        this.currentCapacity = Math.min(this.currentCapacity, this.maxCapacity);
    }
    updateMeasuredRate() {
        const t = this.getCurrentTimeInSeconds();
        const timeBucket = Math.floor(t * 2) / 2;
        this.requestCount++;
        if (timeBucket > this.lastTxRateBucket) {
            const currentRate = this.requestCount / (timeBucket - this.lastTxRateBucket);
            this.measuredTxRate = this.getPrecise(currentRate * this.smooth + this.measuredTxRate * (1 - this.smooth));
            this.requestCount = 0;
            this.lastTxRateBucket = timeBucket;
        }
    }
    getPrecise(num) {
        return parseFloat(num.toFixed(8));
    }
}
DefaultRateLimiter.setTimeoutFn = setTimeout;

const DEFAULT_RETRY_DELAY_BASE = 100;
const MAXIMUM_RETRY_DELAY = 20 * 1000;
const THROTTLING_RETRY_DELAY_BASE = 500;
const INITIAL_RETRY_TOKENS = 500;
const RETRY_COST = 5;
const TIMEOUT_RETRY_COST = 10;
const NO_RETRY_INCREMENT = 1;
const INVOCATION_ID_HEADER = "amz-sdk-invocation-id";
const REQUEST_HEADER = "amz-sdk-request";

const getDefaultRetryBackoffStrategy = () => {
    let delayBase = DEFAULT_RETRY_DELAY_BASE;
    const computeNextBackoffDelay = (attempts) => {
        return Math.floor(Math.min(MAXIMUM_RETRY_DELAY, Math.random() * 2 ** attempts * delayBase));
    };
    const setDelayBase = (delay) => {
        delayBase = delay;
    };
    return {
        computeNextBackoffDelay,
        setDelayBase,
    };
};

const createDefaultRetryToken = ({ retryDelay, retryCount, retryCost, }) => {
    const getRetryCount = () => retryCount;
    const getRetryDelay = () => Math.min(MAXIMUM_RETRY_DELAY, retryDelay);
    const getRetryCost = () => retryCost;
    return {
        getRetryCount,
        getRetryDelay,
        getRetryCost,
    };
};

class StandardRetryStrategy {
    constructor(maxAttempts) {
        this.maxAttempts = maxAttempts;
        this.mode = RETRY_MODES.STANDARD;
        this.capacity = INITIAL_RETRY_TOKENS;
        this.retryBackoffStrategy = getDefaultRetryBackoffStrategy();
        this.maxAttemptsProvider = typeof maxAttempts === "function" ? maxAttempts : async () => maxAttempts;
    }
    async acquireInitialRetryToken(retryTokenScope) {
        return createDefaultRetryToken({
            retryDelay: DEFAULT_RETRY_DELAY_BASE,
            retryCount: 0,
        });
    }
    async refreshRetryTokenForRetry(token, errorInfo) {
        const maxAttempts = await this.getMaxAttempts();
        if (this.shouldRetry(token, errorInfo, maxAttempts)) {
            const errorType = errorInfo.errorType;
            this.retryBackoffStrategy.setDelayBase(errorType === "THROTTLING" ? THROTTLING_RETRY_DELAY_BASE : DEFAULT_RETRY_DELAY_BASE);
            const delayFromErrorType = this.retryBackoffStrategy.computeNextBackoffDelay(token.getRetryCount());
            const retryDelay = errorInfo.retryAfterHint
                ? Math.max(errorInfo.retryAfterHint.getTime() - Date.now() || 0, delayFromErrorType)
                : delayFromErrorType;
            const capacityCost = this.getCapacityCost(errorType);
            this.capacity -= capacityCost;
            return createDefaultRetryToken({
                retryDelay,
                retryCount: token.getRetryCount() + 1,
                retryCost: capacityCost,
            });
        }
        throw new Error("No retry token available");
    }
    recordSuccess(token) {
        this.capacity = Math.max(INITIAL_RETRY_TOKENS, this.capacity + (token.getRetryCost() ?? NO_RETRY_INCREMENT));
    }
    getCapacity() {
        return this.capacity;
    }
    async getMaxAttempts() {
        try {
            return await this.maxAttemptsProvider();
        }
        catch (error) {
            console.warn(`Max attempts provider could not resolve. Using default of ${DEFAULT_MAX_ATTEMPTS}`);
            return DEFAULT_MAX_ATTEMPTS;
        }
    }
    shouldRetry(tokenToRenew, errorInfo, maxAttempts) {
        const attempts = tokenToRenew.getRetryCount() + 1;
        return (attempts < maxAttempts &&
            this.capacity >= this.getCapacityCost(errorInfo.errorType) &&
            this.isRetryableError(errorInfo.errorType));
    }
    getCapacityCost(errorType) {
        return errorType === "TRANSIENT" ? TIMEOUT_RETRY_COST : RETRY_COST;
    }
    isRetryableError(errorType) {
        return errorType === "THROTTLING" || errorType === "TRANSIENT";
    }
}

class AdaptiveRetryStrategy {
    constructor(maxAttemptsProvider, options) {
        this.maxAttemptsProvider = maxAttemptsProvider;
        this.mode = RETRY_MODES.ADAPTIVE;
        const { rateLimiter } = options ?? {};
        this.rateLimiter = rateLimiter ?? new DefaultRateLimiter();
        this.standardRetryStrategy = new StandardRetryStrategy(maxAttemptsProvider);
    }
    async acquireInitialRetryToken(retryTokenScope) {
        await this.rateLimiter.getSendToken();
        return this.standardRetryStrategy.acquireInitialRetryToken(retryTokenScope);
    }
    async refreshRetryTokenForRetry(tokenToRenew, errorInfo) {
        this.rateLimiter.updateClientSendingRate(errorInfo);
        return this.standardRetryStrategy.refreshRetryTokenForRetry(tokenToRenew, errorInfo);
    }
    recordSuccess(token) {
        this.rateLimiter.updateClientSendingRate({});
        this.standardRetryStrategy.recordSuccess(token);
    }
}

// Unique ID creation requires a high quality random # generator. In the browser we therefore
// require the crypto API and do not support built-in fallback to lower quality random number
// generators (like Math.random()).
let getRandomValues;
const rnds8 = new Uint8Array(16);
function rng() {
  // lazy load so that environments that need to polyfill have a chance to do so
  if (!getRandomValues) {
    // getRandomValues needs to be invoked in a context where "this" is a Crypto implementation.
    getRandomValues = typeof crypto !== 'undefined' && crypto.getRandomValues && crypto.getRandomValues.bind(crypto);

    if (!getRandomValues) {
      throw new Error('crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported');
    }
  }

  return getRandomValues(rnds8);
}

/**
 * Convert array of 16 byte values to UUID string format of the form:
 * XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
 */

const byteToHex = [];

for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 0x100).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
  // Note: Be careful editing this code!  It's been tuned for performance
  // and works in ways you may not expect. See https://github.com/uuidjs/uuid/pull/434
  return byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]];
}

const randomUUID = typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID.bind(crypto);
var native = {
  randomUUID
};

function v4(options, buf, offset) {
  if (native.randomUUID && !buf && !options) {
    return native.randomUUID();
  }

  options = options || {};
  const rnds = options.random || (options.rng || rng)(); // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`

  rnds[6] = rnds[6] & 0x0f | 0x40;
  rnds[8] = rnds[8] & 0x3f | 0x80; // Copy bytes to buffer, if provided

  if (buf) {
    offset = offset || 0;

    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }

    return buf;
  }

  return unsafeStringify(rnds);
}

const asSdkError = (error) => {
    if (error instanceof Error)
        return error;
    if (error instanceof Object)
        return Object.assign(new Error(), error);
    if (typeof error === "string")
        return new Error(error);
    return new Error(`AWS SDK error wrapper for ${error}`);
};

const ENV_MAX_ATTEMPTS = "AWS_MAX_ATTEMPTS";
const CONFIG_MAX_ATTEMPTS = "max_attempts";
const NODE_MAX_ATTEMPT_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => {
        const value = env[ENV_MAX_ATTEMPTS];
        if (!value)
            return undefined;
        const maxAttempt = parseInt(value);
        if (Number.isNaN(maxAttempt)) {
            throw new Error(`Environment variable ${ENV_MAX_ATTEMPTS} mast be a number, got "${value}"`);
        }
        return maxAttempt;
    },
    configFileSelector: (profile) => {
        const value = profile[CONFIG_MAX_ATTEMPTS];
        if (!value)
            return undefined;
        const maxAttempt = parseInt(value);
        if (Number.isNaN(maxAttempt)) {
            throw new Error(`Shared config file entry ${CONFIG_MAX_ATTEMPTS} mast be a number, got "${value}"`);
        }
        return maxAttempt;
    },
    default: DEFAULT_MAX_ATTEMPTS,
};
const resolveRetryConfig = (input) => {
    const { retryStrategy } = input;
    const maxAttempts = normalizeProvider$1(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    return {
        ...input,
        maxAttempts,
        retryStrategy: async () => {
            if (retryStrategy) {
                return retryStrategy;
            }
            const retryMode = await normalizeProvider$1(input.retryMode)();
            if (retryMode === RETRY_MODES.ADAPTIVE) {
                return new AdaptiveRetryStrategy(maxAttempts);
            }
            return new StandardRetryStrategy(maxAttempts);
        },
    };
};
const ENV_RETRY_MODE = "AWS_RETRY_MODE";
const CONFIG_RETRY_MODE = "retry_mode";
const NODE_RETRY_MODE_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => env[ENV_RETRY_MODE],
    configFileSelector: (profile) => profile[CONFIG_RETRY_MODE],
    default: DEFAULT_RETRY_MODE,
};

const isStreamingPayload = (request) => request?.body instanceof Readable ||
    (typeof ReadableStream !== "undefined" && request?.body instanceof ReadableStream);

const retryMiddleware = (options) => (next, context) => async (args) => {
    let retryStrategy = await options.retryStrategy();
    const maxAttempts = await options.maxAttempts();
    if (isRetryStrategyV2(retryStrategy)) {
        retryStrategy = retryStrategy;
        let retryToken = await retryStrategy.acquireInitialRetryToken(context["partition_id"]);
        let lastError = new Error();
        let attempts = 0;
        let totalRetryDelay = 0;
        const { request } = args;
        const isRequest = HttpRequest.isInstance(request);
        if (isRequest) {
            request.headers[INVOCATION_ID_HEADER] = v4();
        }
        while (true) {
            try {
                if (isRequest) {
                    request.headers[REQUEST_HEADER] = `attempt=${attempts + 1}; max=${maxAttempts}`;
                }
                const { response, output } = await next(args);
                retryStrategy.recordSuccess(retryToken);
                output.$metadata.attempts = attempts + 1;
                output.$metadata.totalRetryDelay = totalRetryDelay;
                return { response, output };
            }
            catch (e) {
                const retryErrorInfo = getRetryErrorInfo(e);
                lastError = asSdkError(e);
                if (isRequest && isStreamingPayload(request)) {
                    (context.logger instanceof NoOpLogger ? console : context.logger)?.warn("An error was encountered in a non-retryable streaming request.");
                    throw lastError;
                }
                try {
                    retryToken = await retryStrategy.refreshRetryTokenForRetry(retryToken, retryErrorInfo);
                }
                catch (refreshError) {
                    if (!lastError.$metadata) {
                        lastError.$metadata = {};
                    }
                    lastError.$metadata.attempts = attempts + 1;
                    lastError.$metadata.totalRetryDelay = totalRetryDelay;
                    throw lastError;
                }
                attempts = retryToken.getRetryCount();
                const delay = retryToken.getRetryDelay();
                totalRetryDelay += delay;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    else {
        retryStrategy = retryStrategy;
        if (retryStrategy?.mode)
            context.userAgent = [...(context.userAgent || []), ["cfg/retry-mode", retryStrategy.mode]];
        return retryStrategy.retry(next, args);
    }
};
const isRetryStrategyV2 = (retryStrategy) => typeof retryStrategy.acquireInitialRetryToken !== "undefined" &&
    typeof retryStrategy.refreshRetryTokenForRetry !== "undefined" &&
    typeof retryStrategy.recordSuccess !== "undefined";
const getRetryErrorInfo = (error) => {
    const errorInfo = {
        error,
        errorType: getRetryErrorType(error),
    };
    const retryAfterHint = getRetryAfterHint(error.$response);
    if (retryAfterHint) {
        errorInfo.retryAfterHint = retryAfterHint;
    }
    return errorInfo;
};
const getRetryErrorType = (error) => {
    if (isThrottlingError(error))
        return "THROTTLING";
    if (isTransientError(error))
        return "TRANSIENT";
    if (isServerError(error))
        return "SERVER_ERROR";
    return "CLIENT_ERROR";
};
const retryMiddlewareOptions = {
    name: "retryMiddleware",
    tags: ["RETRY"],
    step: "finalizeRequest",
    priority: "high",
    override: true,
};
const getRetryPlugin = (options) => ({
    applyToStack: (clientStack) => {
        clientStack.add(retryMiddleware(options), retryMiddlewareOptions);
    },
});
const getRetryAfterHint = (response) => {
    if (!HttpResponse.isInstance(response))
        return;
    const retryAfterHeaderName = Object.keys(response.headers).find((key) => key.toLowerCase() === "retry-after");
    if (!retryAfterHeaderName)
        return;
    const retryAfter = response.headers[retryAfterHeaderName];
    const retryAfterSeconds = Number(retryAfter);
    if (!Number.isNaN(retryAfterSeconds))
        return new Date(retryAfterSeconds * 1000);
    const retryAfterDate = new Date(retryAfter);
    return retryAfterDate;
};

const signatureV4CrtContainer = {
    CrtSignerV4: null,
};

class SignatureV4MultiRegion {
    sigv4aSigner;
    sigv4Signer;
    signerOptions;
    constructor(options) {
        this.sigv4Signer = new SignatureV4S3Express(options);
        this.signerOptions = options;
    }
    async sign(requestToSign, options = {}) {
        if (options.signingRegion === "*") {
            if (this.signerOptions.runtime !== "node")
                throw new Error("This request requires signing with SigV4Asymmetric algorithm. It's only available in Node.js");
            return this.getSigv4aSigner().sign(requestToSign, options);
        }
        return this.sigv4Signer.sign(requestToSign, options);
    }
    async signWithCredentials(requestToSign, credentials, options = {}) {
        if (options.signingRegion === "*") {
            if (this.signerOptions.runtime !== "node")
                throw new Error("This request requires signing with SigV4Asymmetric algorithm. It's only available in Node.js");
            return this.getSigv4aSigner().signWithCredentials(requestToSign, credentials, options);
        }
        return this.sigv4Signer.signWithCredentials(requestToSign, credentials, options);
    }
    async presign(originalRequest, options = {}) {
        if (options.signingRegion === "*") {
            if (this.signerOptions.runtime !== "node")
                throw new Error("This request requires signing with SigV4Asymmetric algorithm. It's only available in Node.js");
            return this.getSigv4aSigner().presign(originalRequest, options);
        }
        return this.sigv4Signer.presign(originalRequest, options);
    }
    async presignWithCredentials(originalRequest, credentials, options = {}) {
        if (options.signingRegion === "*") {
            throw new Error("Method presignWithCredentials is not supported for [signingRegion=*].");
        }
        return this.sigv4Signer.presignWithCredentials(originalRequest, credentials, options);
    }
    getSigv4aSigner() {
        if (!this.sigv4aSigner) {
            let CrtSignerV4 = null;
            try {
                CrtSignerV4 = signatureV4CrtContainer.CrtSignerV4;
                if (typeof CrtSignerV4 !== "function")
                    throw new Error();
            }
            catch (e) {
                e.message =
                    `${e.message}\n` +
                        `Please check whether you have installed the "@aws-sdk/signature-v4-crt" package explicitly. \n` +
                        `You must also register the package by calling [require("@aws-sdk/signature-v4-crt");] ` +
                        `or an ESM equivalent such as [import "@aws-sdk/signature-v4-crt";]. \n` +
                        "For more information please go to " +
                        "https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt";
                throw e;
            }
            this.sigv4aSigner = new CrtSignerV4({
                ...this.signerOptions,
                signingAlgorithm: 1,
            });
        }
        return this.sigv4aSigner;
    }
}

const ci = "required", cj = "type", ck = "conditions", cl = "fn", cm = "argv", cn = "ref", co = "assign", cp = "url", cq = "properties", cr = "backend", cs = "authSchemes", ct = "disableDoubleEncoding", cu = "signingName", cv = "signingRegion", cw = "headers", cx = "signingRegionSet";
const a = 6, b = false, c = true, d = "isSet", e = "booleanEquals", f = "error", g = "aws.partition", h = "stringEquals", i = "getAttr", j = "name", k = "substring", l = "bucketSuffix", m = "parseURL", n = "{url#scheme}://{url#authority}/{uri_encoded_bucket}{url#path}", o = "endpoint", p = "tree", q = "aws.isVirtualHostableS3Bucket", r = "{url#scheme}://{Bucket}.{url#authority}{url#path}", s = "not", t = "{url#scheme}://{url#authority}{url#path}", u = "hardwareType", v = "regionPrefix", w = "bucketAliasSuffix", x = "outpostId", y = "isValidHostLabel", z = "sigv4a", A = "s3-outposts", B = "s3", C = "{url#scheme}://{url#authority}{url#normalizedPath}{Bucket}", D = "https://{Bucket}.s3-accelerate.{partitionResult#dnsSuffix}", E = "https://{Bucket}.s3.{partitionResult#dnsSuffix}", F = "aws.parseArn", G = "bucketArn", H = "arnType", I = "", J = "s3-object-lambda", K = "accesspoint", L = "accessPointName", M = "{url#scheme}://{accessPointName}-{bucketArn#accountId}.{url#authority}{url#path}", N = "mrapPartition", O = "outpostType", P = "arnPrefix", Q = "{url#scheme}://{url#authority}{url#normalizedPath}{uri_encoded_bucket}", R = "https://s3.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", S = "https://s3.{partitionResult#dnsSuffix}", T = { [ci]: false, [cj]: "String" }, U = { [ci]: true, "default": false, [cj]: "Boolean" }, V = { [ci]: false, [cj]: "Boolean" }, W = { [cl]: e, [cm]: [{ [cn]: "Accelerate" }, true] }, X = { [cl]: e, [cm]: [{ [cn]: "UseFIPS" }, true] }, Y = { [cl]: e, [cm]: [{ [cn]: "UseDualStack" }, true] }, Z = { [cl]: d, [cm]: [{ [cn]: "Endpoint" }] }, aa = { [cl]: g, [cm]: [{ [cn]: "Region" }], [co]: "partitionResult" }, ab = { [cl]: h, [cm]: [{ [cl]: i, [cm]: [{ [cn]: "partitionResult" }, j] }, "aws-cn"] }, ac = { [cl]: d, [cm]: [{ [cn]: "Bucket" }] }, ad = { [cn]: "Bucket" }, ae = { [cl]: m, [cm]: [{ [cn]: "Endpoint" }], [co]: "url" }, af = { [cl]: e, [cm]: [{ [cl]: i, [cm]: [{ [cn]: "url" }, "isIp"] }, true] }, ag = { [cn]: "url" }, ah = { [cl]: "uriEncode", [cm]: [ad], [co]: "uri_encoded_bucket" }, ai = { [cr]: "S3Express", [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: "s3express", [cv]: "{Region}" }] }, aj = {}, ak = { [cl]: q, [cm]: [ad, false] }, al = { [f]: "S3Express bucket name is not a valid virtual hostable name.", [cj]: f }, am = { [cr]: "S3Express", [cs]: [{ [ct]: true, [j]: "sigv4-s3express", [cu]: "s3express", [cv]: "{Region}" }] }, an = { [cl]: d, [cm]: [{ [cn]: "UseS3ExpressControlEndpoint" }] }, ao = { [cl]: e, [cm]: [{ [cn]: "UseS3ExpressControlEndpoint" }, true] }, ap = { [cl]: s, [cm]: [Z] }, aq = { [f]: "Unrecognized S3Express bucket name format.", [cj]: f }, ar = { [cl]: s, [cm]: [ac] }, as = { [cn]: u }, at = { [ck]: [ap], [f]: "Expected a endpoint to be specified but no endpoint was found", [cj]: f }, au = { [cs]: [{ [ct]: true, [j]: z, [cu]: A, [cx]: ["*"] }, { [ct]: true, [j]: "sigv4", [cu]: A, [cv]: "{Region}" }] }, av = { [cl]: e, [cm]: [{ [cn]: "ForcePathStyle" }, false] }, aw = { [cn]: "ForcePathStyle" }, ax = { [cl]: e, [cm]: [{ [cn]: "Accelerate" }, false] }, ay = { [cl]: h, [cm]: [{ [cn]: "Region" }, "aws-global"] }, az = { [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: B, [cv]: "us-east-1" }] }, aA = { [cl]: s, [cm]: [ay] }, aB = { [cl]: e, [cm]: [{ [cn]: "UseGlobalEndpoint" }, true] }, aC = { [cp]: "https://{Bucket}.s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}", [cq]: { [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: B, [cv]: "{Region}" }] }, [cw]: {} }, aD = { [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: B, [cv]: "{Region}" }] }, aE = { [cl]: e, [cm]: [{ [cn]: "UseGlobalEndpoint" }, false] }, aF = { [cl]: e, [cm]: [{ [cn]: "UseDualStack" }, false] }, aG = { [cp]: "https://{Bucket}.s3-fips.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, aH = { [cl]: e, [cm]: [{ [cn]: "UseFIPS" }, false] }, aI = { [cp]: "https://{Bucket}.s3-accelerate.dualstack.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, aJ = { [cp]: "https://{Bucket}.s3.dualstack.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, aK = { [cl]: e, [cm]: [{ [cl]: i, [cm]: [ag, "isIp"] }, false] }, aL = { [cp]: C, [cq]: aD, [cw]: {} }, aM = { [cp]: r, [cq]: aD, [cw]: {} }, aN = { [o]: aM, [cj]: o }, aO = { [cp]: D, [cq]: aD, [cw]: {} }, aP = { [cp]: "https://{Bucket}.s3.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, aQ = { [f]: "Invalid region: region was not a valid DNS name.", [cj]: f }, aR = { [cn]: G }, aS = { [cn]: H }, aT = { [cl]: i, [cm]: [aR, "service"] }, aU = { [cn]: L }, aV = { [ck]: [Y], [f]: "S3 Object Lambda does not support Dual-stack", [cj]: f }, aW = { [ck]: [W], [f]: "S3 Object Lambda does not support S3 Accelerate", [cj]: f }, aX = { [ck]: [{ [cl]: d, [cm]: [{ [cn]: "DisableAccessPoints" }] }, { [cl]: e, [cm]: [{ [cn]: "DisableAccessPoints" }, true] }], [f]: "Access points are not supported for this operation", [cj]: f }, aY = { [ck]: [{ [cl]: d, [cm]: [{ [cn]: "UseArnRegion" }] }, { [cl]: e, [cm]: [{ [cn]: "UseArnRegion" }, false] }, { [cl]: s, [cm]: [{ [cl]: h, [cm]: [{ [cl]: i, [cm]: [aR, "region"] }, "{Region}"] }] }], [f]: "Invalid configuration: region from ARN `{bucketArn#region}` does not match client region `{Region}` and UseArnRegion is `false`", [cj]: f }, aZ = { [cl]: i, [cm]: [{ [cn]: "bucketPartition" }, j] }, ba = { [cl]: i, [cm]: [aR, "accountId"] }, bb = { [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: J, [cv]: "{bucketArn#region}" }] }, bc = { [f]: "Invalid ARN: The access point name may only contain a-z, A-Z, 0-9 and `-`. Found: `{accessPointName}`", [cj]: f }, bd = { [f]: "Invalid ARN: The account id may only contain a-z, A-Z, 0-9 and `-`. Found: `{bucketArn#accountId}`", [cj]: f }, be = { [f]: "Invalid region in ARN: `{bucketArn#region}` (invalid DNS name)", [cj]: f }, bf = { [f]: "Client was configured for partition `{partitionResult#name}` but ARN (`{Bucket}`) has `{bucketPartition#name}`", [cj]: f }, bg = { [f]: "Invalid ARN: The ARN may only contain a single resource component after `accesspoint`.", [cj]: f }, bh = { [f]: "Invalid ARN: Expected a resource of the format `accesspoint:<accesspoint name>` but no name was provided", [cj]: f }, bi = { [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: B, [cv]: "{bucketArn#region}" }] }, bj = { [cs]: [{ [ct]: true, [j]: z, [cu]: A, [cx]: ["*"] }, { [ct]: true, [j]: "sigv4", [cu]: A, [cv]: "{bucketArn#region}" }] }, bk = { [cl]: F, [cm]: [ad] }, bl = { [cp]: "https://s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: aD, [cw]: {} }, bm = { [cp]: "https://s3-fips.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: aD, [cw]: {} }, bn = { [cp]: "https://s3.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: aD, [cw]: {} }, bo = { [cp]: Q, [cq]: aD, [cw]: {} }, bp = { [cp]: "https://s3.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: aD, [cw]: {} }, bq = { [cn]: "UseObjectLambdaEndpoint" }, br = { [cs]: [{ [ct]: true, [j]: "sigv4", [cu]: J, [cv]: "{Region}" }] }, bs = { [cp]: "https://s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, bt = { [cp]: "https://s3-fips.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, bu = { [cp]: "https://s3.dualstack.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, bv = { [cp]: t, [cq]: aD, [cw]: {} }, bw = { [cp]: "https://s3.{Region}.{partitionResult#dnsSuffix}", [cq]: aD, [cw]: {} }, bx = [{ [cn]: "Region" }], by = [{ [cn]: "Endpoint" }], bz = [ad], bA = [Y], bB = [W], bC = [Z, ae], bD = [{ [cl]: d, [cm]: [{ [cn]: "DisableS3ExpressSessionAuth" }] }, { [cl]: e, [cm]: [{ [cn]: "DisableS3ExpressSessionAuth" }, true] }], bE = [af], bF = [ah], bG = [ak], bH = [X], bI = [{ [cl]: k, [cm]: [ad, 6, 14, true], [co]: "s3expressAvailabilityZoneId" }, { [cl]: k, [cm]: [ad, 14, 16, true], [co]: "s3expressAvailabilityZoneDelim" }, { [cl]: h, [cm]: [{ [cn]: "s3expressAvailabilityZoneDelim" }, "--"] }], bJ = [{ [ck]: [X], [o]: { [cp]: "https://{Bucket}.s3express-fips-{s3expressAvailabilityZoneId}.{Region}.amazonaws.com", [cq]: ai, [cw]: {} }, [cj]: o }, { [o]: { [cp]: "https://{Bucket}.s3express-{s3expressAvailabilityZoneId}.{Region}.amazonaws.com", [cq]: ai, [cw]: {} }, [cj]: o }], bK = [{ [cl]: k, [cm]: [ad, 6, 15, true], [co]: "s3expressAvailabilityZoneId" }, { [cl]: k, [cm]: [ad, 15, 17, true], [co]: "s3expressAvailabilityZoneDelim" }, { [cl]: h, [cm]: [{ [cn]: "s3expressAvailabilityZoneDelim" }, "--"] }], bL = [{ [cl]: k, [cm]: [ad, 6, 19, true], [co]: "s3expressAvailabilityZoneId" }, { [cl]: k, [cm]: [ad, 19, 21, true], [co]: "s3expressAvailabilityZoneDelim" }, { [cl]: h, [cm]: [{ [cn]: "s3expressAvailabilityZoneDelim" }, "--"] }], bM = [{ [cl]: k, [cm]: [ad, 6, 20, true], [co]: "s3expressAvailabilityZoneId" }, { [cl]: k, [cm]: [ad, 20, 22, true], [co]: "s3expressAvailabilityZoneDelim" }, { [cl]: h, [cm]: [{ [cn]: "s3expressAvailabilityZoneDelim" }, "--"] }], bN = [{ [cl]: k, [cm]: [ad, 6, 26, true], [co]: "s3expressAvailabilityZoneId" }, { [cl]: k, [cm]: [ad, 26, 28, true], [co]: "s3expressAvailabilityZoneDelim" }, { [cl]: h, [cm]: [{ [cn]: "s3expressAvailabilityZoneDelim" }, "--"] }], bO = [{ [ck]: [X], [o]: { [cp]: "https://{Bucket}.s3express-fips-{s3expressAvailabilityZoneId}.{Region}.amazonaws.com", [cq]: am, [cw]: {} }, [cj]: o }, { [o]: { [cp]: "https://{Bucket}.s3express-{s3expressAvailabilityZoneId}.{Region}.amazonaws.com", [cq]: am, [cw]: {} }, [cj]: o }], bP = [ac], bQ = [{ [cl]: y, [cm]: [{ [cn]: x }, false] }], bR = [{ [cl]: h, [cm]: [{ [cn]: v }, "beta"] }], bS = ["*"], bT = [aa], bU = [{ [cl]: y, [cm]: [{ [cn]: "Region" }, false] }], bV = [{ [cl]: h, [cm]: [{ [cn]: "Region" }, "us-east-1"] }], bW = [{ [cl]: h, [cm]: [aS, K] }], bX = [{ [cl]: i, [cm]: [aR, "resourceId[1]"], [co]: L }, { [cl]: s, [cm]: [{ [cl]: h, [cm]: [aU, I] }] }], bY = [aR, "resourceId[1]"], bZ = [{ [cl]: s, [cm]: [{ [cl]: h, [cm]: [{ [cl]: i, [cm]: [aR, "region"] }, I] }] }], ca = [{ [cl]: s, [cm]: [{ [cl]: d, [cm]: [{ [cl]: i, [cm]: [aR, "resourceId[2]"] }] }] }], cb = [aR, "resourceId[2]"], cc = [{ [cl]: g, [cm]: [{ [cl]: i, [cm]: [aR, "region"] }], [co]: "bucketPartition" }], cd = [{ [cl]: h, [cm]: [aZ, { [cl]: i, [cm]: [{ [cn]: "partitionResult" }, j] }] }], ce = [{ [cl]: y, [cm]: [{ [cl]: i, [cm]: [aR, "region"] }, true] }], cf = [{ [cl]: y, [cm]: [ba, false] }], cg = [{ [cl]: y, [cm]: [aU, false] }], ch = [{ [cl]: y, [cm]: [{ [cn]: "Region" }, true] }];
const _data = { version: "1.0", parameters: { Bucket: T, Region: T, UseFIPS: U, UseDualStack: U, Endpoint: T, ForcePathStyle: U, Accelerate: U, UseGlobalEndpoint: U, UseObjectLambdaEndpoint: V, Key: T, Prefix: T, CopySource: T, DisableAccessPoints: V, DisableMultiRegionAccessPoints: U, UseArnRegion: V, UseS3ExpressControlEndpoint: V, DisableS3ExpressSessionAuth: V }, rules: [{ [ck]: [{ [cl]: d, [cm]: bx }], rules: [{ [ck]: [W, X], error: "Accelerate cannot be used with FIPS", [cj]: f }, { [ck]: [Y, Z], error: "Cannot set dual-stack in combination with a custom endpoint.", [cj]: f }, { [ck]: [Z, X], error: "A custom endpoint cannot be combined with FIPS", [cj]: f }, { [ck]: [Z, W], error: "A custom endpoint cannot be combined with S3 Accelerate", [cj]: f }, { [ck]: [X, aa, ab], error: "Partition does not support FIPS", [cj]: f }, { [ck]: [ac, { [cl]: k, [cm]: [ad, 0, a, c], [co]: l }, { [cl]: h, [cm]: [{ [cn]: l }, "--x-s3"] }], rules: [{ [ck]: bA, error: "S3Express does not support Dual-stack.", [cj]: f }, { [ck]: bB, error: "S3Express does not support S3 Accelerate.", [cj]: f }, { [ck]: bC, rules: [{ [ck]: bD, rules: [{ [ck]: bE, rules: [{ [ck]: bF, rules: [{ endpoint: { [cp]: n, [cq]: ai, [cw]: aj }, [cj]: o }], [cj]: p }], [cj]: p }, { [ck]: bG, rules: [{ endpoint: { [cp]: r, [cq]: ai, [cw]: aj }, [cj]: o }], [cj]: p }, al], [cj]: p }, { [ck]: bE, rules: [{ [ck]: bF, rules: [{ endpoint: { [cp]: n, [cq]: am, [cw]: aj }, [cj]: o }], [cj]: p }], [cj]: p }, { [ck]: bG, rules: [{ endpoint: { [cp]: r, [cq]: am, [cw]: aj }, [cj]: o }], [cj]: p }, al], [cj]: p }, { [ck]: [an, ao], rules: [{ [ck]: [ah, ap], rules: [{ [ck]: bH, endpoint: { [cp]: "https://s3express-control-fips.{Region}.amazonaws.com/{uri_encoded_bucket}", [cq]: ai, [cw]: aj }, [cj]: o }, { endpoint: { [cp]: "https://s3express-control.{Region}.amazonaws.com/{uri_encoded_bucket}", [cq]: ai, [cw]: aj }, [cj]: o }], [cj]: p }], [cj]: p }, { [ck]: bG, rules: [{ [ck]: bD, rules: [{ [ck]: bI, rules: bJ, [cj]: p }, { [ck]: bK, rules: bJ, [cj]: p }, { [ck]: bL, rules: bJ, [cj]: p }, { [ck]: bM, rules: bJ, [cj]: p }, { [ck]: bN, rules: bJ, [cj]: p }, aq], [cj]: p }, { [ck]: bI, rules: bO, [cj]: p }, { [ck]: bK, rules: bO, [cj]: p }, { [ck]: bL, rules: bO, [cj]: p }, { [ck]: bM, rules: bO, [cj]: p }, { [ck]: bN, rules: bO, [cj]: p }, aq], [cj]: p }, al], [cj]: p }, { [ck]: [ar, an, ao], rules: [{ [ck]: bC, endpoint: { [cp]: t, [cq]: ai, [cw]: aj }, [cj]: o }, { [ck]: bH, endpoint: { [cp]: "https://s3express-control-fips.{Region}.amazonaws.com", [cq]: ai, [cw]: aj }, [cj]: o }, { endpoint: { [cp]: "https://s3express-control.{Region}.amazonaws.com", [cq]: ai, [cw]: aj }, [cj]: o }], [cj]: p }, { [ck]: [ac, { [cl]: k, [cm]: [ad, 49, 50, c], [co]: u }, { [cl]: k, [cm]: [ad, 8, 12, c], [co]: v }, { [cl]: k, [cm]: [ad, 0, 7, c], [co]: w }, { [cl]: k, [cm]: [ad, 32, 49, c], [co]: x }, { [cl]: g, [cm]: bx, [co]: "regionPartition" }, { [cl]: h, [cm]: [{ [cn]: w }, "--op-s3"] }], rules: [{ [ck]: bQ, rules: [{ [ck]: [{ [cl]: h, [cm]: [as, "e"] }], rules: [{ [ck]: bR, rules: [at, { [ck]: bC, endpoint: { [cp]: "https://{Bucket}.ec2.{url#authority}", [cq]: au, [cw]: aj }, [cj]: o }], [cj]: p }, { endpoint: { [cp]: "https://{Bucket}.ec2.s3-outposts.{Region}.{regionPartition#dnsSuffix}", [cq]: au, [cw]: aj }, [cj]: o }], [cj]: p }, { [ck]: [{ [cl]: h, [cm]: [as, "o"] }], rules: [{ [ck]: bR, rules: [at, { [ck]: bC, endpoint: { [cp]: "https://{Bucket}.op-{outpostId}.{url#authority}", [cq]: au, [cw]: aj }, [cj]: o }], [cj]: p }, { endpoint: { [cp]: "https://{Bucket}.op-{outpostId}.s3-outposts.{Region}.{regionPartition#dnsSuffix}", [cq]: au, [cw]: aj }, [cj]: o }], [cj]: p }, { error: "Unrecognized hardware type: \"Expected hardware type o or e but got {hardwareType}\"", [cj]: f }], [cj]: p }, { error: "Invalid ARN: The outpost Id must only contain a-z, A-Z, 0-9 and `-`.", [cj]: f }], [cj]: p }, { [ck]: bP, rules: [{ [ck]: [Z, { [cl]: s, [cm]: [{ [cl]: d, [cm]: [{ [cl]: m, [cm]: by }] }] }], error: "Custom endpoint `{Endpoint}` was not a valid URI", [cj]: f }, { [ck]: [av, ak], rules: [{ [ck]: bT, rules: [{ [ck]: bU, rules: [{ [ck]: [W, ab], error: "S3 Accelerate cannot be used in this region", [cj]: f }, { [ck]: [Y, X, ax, ap, ay], endpoint: { [cp]: "https://{Bucket}.s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [Y, X, ax, ap, aA, aB], rules: [{ endpoint: aC, [cj]: o }], [cj]: p }, { [ck]: [Y, X, ax, ap, aA, aE], endpoint: aC, [cj]: o }, { [ck]: [aF, X, ax, ap, ay], endpoint: { [cp]: "https://{Bucket}.s3-fips.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, X, ax, ap, aA, aB], rules: [{ endpoint: aG, [cj]: o }], [cj]: p }, { [ck]: [aF, X, ax, ap, aA, aE], endpoint: aG, [cj]: o }, { [ck]: [Y, aH, W, ap, ay], endpoint: { [cp]: "https://{Bucket}.s3-accelerate.dualstack.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [Y, aH, W, ap, aA, aB], rules: [{ endpoint: aI, [cj]: o }], [cj]: p }, { [ck]: [Y, aH, W, ap, aA, aE], endpoint: aI, [cj]: o }, { [ck]: [Y, aH, ax, ap, ay], endpoint: { [cp]: "https://{Bucket}.s3.dualstack.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [Y, aH, ax, ap, aA, aB], rules: [{ endpoint: aJ, [cj]: o }], [cj]: p }, { [ck]: [Y, aH, ax, ap, aA, aE], endpoint: aJ, [cj]: o }, { [ck]: [aF, aH, ax, Z, ae, af, ay], endpoint: { [cp]: C, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, aH, ax, Z, ae, aK, ay], endpoint: { [cp]: r, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, aH, ax, Z, ae, af, aA, aB], rules: [{ [ck]: bV, endpoint: aL, [cj]: o }, { endpoint: aL, [cj]: o }], [cj]: p }, { [ck]: [aF, aH, ax, Z, ae, aK, aA, aB], rules: [{ [ck]: bV, endpoint: aM, [cj]: o }, aN], [cj]: p }, { [ck]: [aF, aH, ax, Z, ae, af, aA, aE], endpoint: aL, [cj]: o }, { [ck]: [aF, aH, ax, Z, ae, aK, aA, aE], endpoint: aM, [cj]: o }, { [ck]: [aF, aH, W, ap, ay], endpoint: { [cp]: D, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, aH, W, ap, aA, aB], rules: [{ [ck]: bV, endpoint: aO, [cj]: o }, { endpoint: aO, [cj]: o }], [cj]: p }, { [ck]: [aF, aH, W, ap, aA, aE], endpoint: aO, [cj]: o }, { [ck]: [aF, aH, ax, ap, ay], endpoint: { [cp]: E, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, aH, ax, ap, aA, aB], rules: [{ [ck]: bV, endpoint: { [cp]: E, [cq]: aD, [cw]: aj }, [cj]: o }, { endpoint: aP, [cj]: o }], [cj]: p }, { [ck]: [aF, aH, ax, ap, aA, aE], endpoint: aP, [cj]: o }], [cj]: p }, aQ], [cj]: p }], [cj]: p }, { [ck]: [Z, ae, { [cl]: h, [cm]: [{ [cl]: i, [cm]: [ag, "scheme"] }, "http"] }, { [cl]: q, [cm]: [ad, c] }, av, aH, aF, ax], rules: [{ [ck]: bT, rules: [{ [ck]: bU, rules: [aN], [cj]: p }, aQ], [cj]: p }], [cj]: p }, { [ck]: [av, { [cl]: F, [cm]: bz, [co]: G }], rules: [{ [ck]: [{ [cl]: i, [cm]: [aR, "resourceId[0]"], [co]: H }, { [cl]: s, [cm]: [{ [cl]: h, [cm]: [aS, I] }] }], rules: [{ [ck]: [{ [cl]: h, [cm]: [aT, J] }], rules: [{ [ck]: bW, rules: [{ [ck]: bX, rules: [aV, aW, { [ck]: bZ, rules: [aX, { [ck]: ca, rules: [aY, { [ck]: cc, rules: [{ [ck]: bT, rules: [{ [ck]: cd, rules: [{ [ck]: ce, rules: [{ [ck]: [{ [cl]: h, [cm]: [ba, I] }], error: "Invalid ARN: Missing account id", [cj]: f }, { [ck]: cf, rules: [{ [ck]: cg, rules: [{ [ck]: bC, endpoint: { [cp]: M, [cq]: bb, [cw]: aj }, [cj]: o }, { [ck]: bH, endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.s3-object-lambda-fips.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bb, [cw]: aj }, [cj]: o }, { endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.s3-object-lambda.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bb, [cw]: aj }, [cj]: o }], [cj]: p }, bc], [cj]: p }, bd], [cj]: p }, be], [cj]: p }, bf], [cj]: p }], [cj]: p }], [cj]: p }, bg], [cj]: p }, { error: "Invalid ARN: bucket ARN is missing a region", [cj]: f }], [cj]: p }, bh], [cj]: p }, { error: "Invalid ARN: Object Lambda ARNs only support `accesspoint` arn types, but found: `{arnType}`", [cj]: f }], [cj]: p }, { [ck]: bW, rules: [{ [ck]: bX, rules: [{ [ck]: bZ, rules: [{ [ck]: bW, rules: [{ [ck]: bZ, rules: [aX, { [ck]: ca, rules: [aY, { [ck]: cc, rules: [{ [ck]: bT, rules: [{ [ck]: [{ [cl]: h, [cm]: [aZ, "{partitionResult#name}"] }], rules: [{ [ck]: ce, rules: [{ [ck]: [{ [cl]: h, [cm]: [aT, B] }], rules: [{ [ck]: cf, rules: [{ [ck]: cg, rules: [{ [ck]: bB, error: "Access Points do not support S3 Accelerate", [cj]: f }, { [ck]: [X, Y], endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint-fips.dualstack.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bi, [cw]: aj }, [cj]: o }, { [ck]: [X, aF], endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint-fips.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bi, [cw]: aj }, [cj]: o }, { [ck]: [aH, Y], endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint.dualstack.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bi, [cw]: aj }, [cj]: o }, { [ck]: [aH, aF, Z, ae], endpoint: { [cp]: M, [cq]: bi, [cw]: aj }, [cj]: o }, { [ck]: [aH, aF], endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bi, [cw]: aj }, [cj]: o }], [cj]: p }, bc], [cj]: p }, bd], [cj]: p }, { error: "Invalid ARN: The ARN was not for the S3 service, found: {bucketArn#service}", [cj]: f }], [cj]: p }, be], [cj]: p }, bf], [cj]: p }], [cj]: p }], [cj]: p }, bg], [cj]: p }], [cj]: p }], [cj]: p }, { [ck]: [{ [cl]: y, [cm]: [aU, c] }], rules: [{ [ck]: bA, error: "S3 MRAP does not support dual-stack", [cj]: f }, { [ck]: bH, error: "S3 MRAP does not support FIPS", [cj]: f }, { [ck]: bB, error: "S3 MRAP does not support S3 Accelerate", [cj]: f }, { [ck]: [{ [cl]: e, [cm]: [{ [cn]: "DisableMultiRegionAccessPoints" }, c] }], error: "Invalid configuration: Multi-Region Access Point ARNs are disabled.", [cj]: f }, { [ck]: [{ [cl]: g, [cm]: bx, [co]: N }], rules: [{ [ck]: [{ [cl]: h, [cm]: [{ [cl]: i, [cm]: [{ [cn]: N }, j] }, { [cl]: i, [cm]: [aR, "partition"] }] }], rules: [{ endpoint: { [cp]: "https://{accessPointName}.accesspoint.s3-global.{mrapPartition#dnsSuffix}", [cq]: { [cs]: [{ [ct]: c, name: z, [cu]: B, [cx]: bS }] }, [cw]: aj }, [cj]: o }], [cj]: p }, { error: "Client was configured for partition `{mrapPartition#name}` but bucket referred to partition `{bucketArn#partition}`", [cj]: f }], [cj]: p }], [cj]: p }, { error: "Invalid Access Point Name", [cj]: f }], [cj]: p }, bh], [cj]: p }, { [ck]: [{ [cl]: h, [cm]: [aT, A] }], rules: [{ [ck]: bA, error: "S3 Outposts does not support Dual-stack", [cj]: f }, { [ck]: bH, error: "S3 Outposts does not support FIPS", [cj]: f }, { [ck]: bB, error: "S3 Outposts does not support S3 Accelerate", [cj]: f }, { [ck]: [{ [cl]: d, [cm]: [{ [cl]: i, [cm]: [aR, "resourceId[4]"] }] }], error: "Invalid Arn: Outpost Access Point ARN contains sub resources", [cj]: f }, { [ck]: [{ [cl]: i, [cm]: bY, [co]: x }], rules: [{ [ck]: bQ, rules: [aY, { [ck]: cc, rules: [{ [ck]: bT, rules: [{ [ck]: cd, rules: [{ [ck]: ce, rules: [{ [ck]: cf, rules: [{ [ck]: [{ [cl]: i, [cm]: cb, [co]: O }], rules: [{ [ck]: [{ [cl]: i, [cm]: [aR, "resourceId[3]"], [co]: L }], rules: [{ [ck]: [{ [cl]: h, [cm]: [{ [cn]: O }, K] }], rules: [{ [ck]: bC, endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.{outpostId}.{url#authority}", [cq]: bj, [cw]: aj }, [cj]: o }, { endpoint: { [cp]: "https://{accessPointName}-{bucketArn#accountId}.{outpostId}.s3-outposts.{bucketArn#region}.{bucketPartition#dnsSuffix}", [cq]: bj, [cw]: aj }, [cj]: o }], [cj]: p }, { error: "Expected an outpost type `accesspoint`, found {outpostType}", [cj]: f }], [cj]: p }, { error: "Invalid ARN: expected an access point name", [cj]: f }], [cj]: p }, { error: "Invalid ARN: Expected a 4-component resource", [cj]: f }], [cj]: p }, bd], [cj]: p }, be], [cj]: p }, bf], [cj]: p }], [cj]: p }], [cj]: p }, { error: "Invalid ARN: The outpost Id may only contain a-z, A-Z, 0-9 and `-`. Found: `{outpostId}`", [cj]: f }], [cj]: p }, { error: "Invalid ARN: The Outpost Id was not set", [cj]: f }], [cj]: p }, { error: "Invalid ARN: Unrecognized format: {Bucket} (type: {arnType})", [cj]: f }], [cj]: p }, { error: "Invalid ARN: No ARN type specified", [cj]: f }], [cj]: p }, { [ck]: [{ [cl]: k, [cm]: [ad, 0, 4, b], [co]: P }, { [cl]: h, [cm]: [{ [cn]: P }, "arn:"] }, { [cl]: s, [cm]: [{ [cl]: d, [cm]: [bk] }] }], error: "Invalid ARN: `{Bucket}` was not a valid ARN", [cj]: f }, { [ck]: [{ [cl]: e, [cm]: [aw, c] }, bk], error: "Path-style addressing cannot be used with ARN buckets", [cj]: f }, { [ck]: bF, rules: [{ [ck]: bT, rules: [{ [ck]: [ax], rules: [{ [ck]: [Y, ap, X, ay], endpoint: { [cp]: "https://s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [Y, ap, X, aA, aB], rules: [{ endpoint: bl, [cj]: o }], [cj]: p }, { [ck]: [Y, ap, X, aA, aE], endpoint: bl, [cj]: o }, { [ck]: [aF, ap, X, ay], endpoint: { [cp]: "https://s3-fips.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, ap, X, aA, aB], rules: [{ endpoint: bm, [cj]: o }], [cj]: p }, { [ck]: [aF, ap, X, aA, aE], endpoint: bm, [cj]: o }, { [ck]: [Y, ap, aH, ay], endpoint: { [cp]: "https://s3.dualstack.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [Y, ap, aH, aA, aB], rules: [{ endpoint: bn, [cj]: o }], [cj]: p }, { [ck]: [Y, ap, aH, aA, aE], endpoint: bn, [cj]: o }, { [ck]: [aF, Z, ae, aH, ay], endpoint: { [cp]: Q, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, Z, ae, aH, aA, aB], rules: [{ [ck]: bV, endpoint: bo, [cj]: o }, { endpoint: bo, [cj]: o }], [cj]: p }, { [ck]: [aF, Z, ae, aH, aA, aE], endpoint: bo, [cj]: o }, { [ck]: [aF, ap, aH, ay], endpoint: { [cp]: R, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aF, ap, aH, aA, aB], rules: [{ [ck]: bV, endpoint: { [cp]: R, [cq]: aD, [cw]: aj }, [cj]: o }, { endpoint: bp, [cj]: o }], [cj]: p }, { [ck]: [aF, ap, aH, aA, aE], endpoint: bp, [cj]: o }], [cj]: p }, { error: "Path-style addressing cannot be used with S3 Accelerate", [cj]: f }], [cj]: p }], [cj]: p }], [cj]: p }, { [ck]: [{ [cl]: d, [cm]: [bq] }, { [cl]: e, [cm]: [bq, c] }], rules: [{ [ck]: bT, rules: [{ [ck]: ch, rules: [aV, aW, { [ck]: bC, endpoint: { [cp]: t, [cq]: br, [cw]: aj }, [cj]: o }, { [ck]: bH, endpoint: { [cp]: "https://s3-object-lambda-fips.{Region}.{partitionResult#dnsSuffix}", [cq]: br, [cw]: aj }, [cj]: o }, { endpoint: { [cp]: "https://s3-object-lambda.{Region}.{partitionResult#dnsSuffix}", [cq]: br, [cw]: aj }, [cj]: o }], [cj]: p }, aQ], [cj]: p }], [cj]: p }, { [ck]: [ar], rules: [{ [ck]: bT, rules: [{ [ck]: ch, rules: [{ [ck]: [X, Y, ap, ay], endpoint: { [cp]: "https://s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [X, Y, ap, aA, aB], rules: [{ endpoint: bs, [cj]: o }], [cj]: p }, { [ck]: [X, Y, ap, aA, aE], endpoint: bs, [cj]: o }, { [ck]: [X, aF, ap, ay], endpoint: { [cp]: "https://s3-fips.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [X, aF, ap, aA, aB], rules: [{ endpoint: bt, [cj]: o }], [cj]: p }, { [ck]: [X, aF, ap, aA, aE], endpoint: bt, [cj]: o }, { [ck]: [aH, Y, ap, ay], endpoint: { [cp]: "https://s3.dualstack.us-east-1.{partitionResult#dnsSuffix}", [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aH, Y, ap, aA, aB], rules: [{ endpoint: bu, [cj]: o }], [cj]: p }, { [ck]: [aH, Y, ap, aA, aE], endpoint: bu, [cj]: o }, { [ck]: [aH, aF, Z, ae, ay], endpoint: { [cp]: t, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aH, aF, Z, ae, aA, aB], rules: [{ [ck]: bV, endpoint: bv, [cj]: o }, { endpoint: bv, [cj]: o }], [cj]: p }, { [ck]: [aH, aF, Z, ae, aA, aE], endpoint: bv, [cj]: o }, { [ck]: [aH, aF, ap, ay], endpoint: { [cp]: S, [cq]: az, [cw]: aj }, [cj]: o }, { [ck]: [aH, aF, ap, aA, aB], rules: [{ [ck]: bV, endpoint: { [cp]: S, [cq]: aD, [cw]: aj }, [cj]: o }, { endpoint: bw, [cj]: o }], [cj]: p }, { [ck]: [aH, aF, ap, aA, aE], endpoint: bw, [cj]: o }], [cj]: p }, aQ], [cj]: p }], [cj]: p }], [cj]: p }, { error: "A region must be set when sending requests to S3.", [cj]: f }] };
const ruleSet = _data;

const cache = new EndpointCache({
    size: 50,
    params: [
        "Accelerate",
        "Bucket",
        "DisableAccessPoints",
        "DisableMultiRegionAccessPoints",
        "DisableS3ExpressSessionAuth",
        "Endpoint",
        "ForcePathStyle",
        "Region",
        "UseArnRegion",
        "UseDualStack",
        "UseFIPS",
        "UseGlobalEndpoint",
        "UseObjectLambdaEndpoint",
        "UseS3ExpressControlEndpoint",
    ],
});
const defaultEndpointResolver = (endpointParams, context = {}) => {
    return cache.get(endpointParams, () => resolveEndpoint(ruleSet, {
        endpointParams: endpointParams,
        logger: context.logger,
    }));
};
customEndpointFunctions.aws = awsEndpointFunctions;

const createEndpointRuleSetHttpAuthSchemeParametersProvider = (defaultHttpAuthSchemeParametersProvider) => async (config, context, input) => {
    if (!input) {
        throw new Error(`Could not find \`input\` for \`defaultEndpointRuleSetHttpAuthSchemeParametersProvider\``);
    }
    const defaultParameters = await defaultHttpAuthSchemeParametersProvider(config, context, input);
    const instructionsFn = getSmithyContext(context)?.commandInstance?.constructor
        ?.getEndpointParameterInstructions;
    if (!instructionsFn) {
        throw new Error(`getEndpointParameterInstructions() is not defined on \`${context.commandName}\``);
    }
    const endpointParameters = await resolveParams(input, { getEndpointParameterInstructions: instructionsFn }, config);
    return Object.assign(defaultParameters, endpointParameters);
};
const _defaultS3HttpAuthSchemeParametersProvider = async (config, context, input) => {
    return {
        operation: getSmithyContext(context).operation,
        region: (await normalizeProvider$1(config.region)()) ||
            (() => {
                throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
            })(),
    };
};
const defaultS3HttpAuthSchemeParametersProvider = createEndpointRuleSetHttpAuthSchemeParametersProvider(_defaultS3HttpAuthSchemeParametersProvider);
function createAwsAuthSigv4HttpAuthOption(authParameters) {
    return {
        schemeId: "aws.auth#sigv4",
        signingProperties: {
            name: "s3",
            region: authParameters.region,
        },
        propertiesExtractor: (config, context) => ({
            signingProperties: {
                config,
                context,
            },
        }),
    };
}
function createAwsAuthSigv4aHttpAuthOption(authParameters) {
    return {
        schemeId: "aws.auth#sigv4a",
        signingProperties: {
            name: "s3",
            region: authParameters.region,
        },
        propertiesExtractor: (config, context) => ({
            signingProperties: {
                config,
                context,
            },
        }),
    };
}
const createEndpointRuleSetHttpAuthSchemeProvider = (defaultEndpointResolver, defaultHttpAuthSchemeResolver, createHttpAuthOptionFunctions) => {
    const endpointRuleSetHttpAuthSchemeProvider = (authParameters) => {
        const endpoint = defaultEndpointResolver(authParameters);
        const authSchemes = endpoint.properties?.authSchemes;
        if (!authSchemes) {
            return defaultHttpAuthSchemeResolver(authParameters);
        }
        const options = [];
        for (const scheme of authSchemes) {
            const { name: resolvedName, properties = {}, ...rest } = scheme;
            const name = resolvedName.toLowerCase();
            if (resolvedName !== name) {
                console.warn(`HttpAuthScheme has been normalized with lowercasing: \`${resolvedName}\` to \`${name}\``);
            }
            let schemeId;
            if (name === "sigv4a") {
                schemeId = "aws.auth#sigv4a";
                const sigv4Present = authSchemes.find((s) => {
                    const name = s.name.toLowerCase();
                    return name !== "sigv4a" && name.startsWith("sigv4");
                });
                if (sigv4Present) {
                    continue;
                }
            }
            else if (name.startsWith("sigv4")) {
                schemeId = "aws.auth#sigv4";
            }
            else {
                throw new Error(`Unknown HttpAuthScheme found in \`@smithy.rules#endpointRuleSet\`: \`${name}\``);
            }
            const createOption = createHttpAuthOptionFunctions[schemeId];
            if (!createOption) {
                throw new Error(`Could not find HttpAuthOption create function for \`${schemeId}\``);
            }
            const option = createOption(authParameters);
            option.schemeId = schemeId;
            option.signingProperties = { ...(option.signingProperties || {}), ...rest, ...properties };
            options.push(option);
        }
        return options;
    };
    return endpointRuleSetHttpAuthSchemeProvider;
};
const _defaultS3HttpAuthSchemeProvider = (authParameters) => {
    const options = [];
    switch (authParameters.operation) {
        default: {
            options.push(createAwsAuthSigv4HttpAuthOption(authParameters));
            options.push(createAwsAuthSigv4aHttpAuthOption(authParameters));
        }
    }
    return options;
};
const defaultS3HttpAuthSchemeProvider = createEndpointRuleSetHttpAuthSchemeProvider(defaultEndpointResolver, _defaultS3HttpAuthSchemeProvider, {
    "aws.auth#sigv4": createAwsAuthSigv4HttpAuthOption,
    "aws.auth#sigv4a": createAwsAuthSigv4aHttpAuthOption,
});
const resolveHttpAuthSchemeConfig = (config) => {
    const config_0 = resolveAwsSdkSigV4Config(config);
    const config_1 = resolveAwsSdkSigV4AConfig(config_0);
    return {
        ...config_1,
    };
};

const resolveClientEndpointParameters = (options) => {
    return {
        ...options,
        useFipsEndpoint: options.useFipsEndpoint ?? false,
        useDualstackEndpoint: options.useDualstackEndpoint ?? false,
        forcePathStyle: options.forcePathStyle ?? false,
        useAccelerateEndpoint: options.useAccelerateEndpoint ?? false,
        useGlobalEndpoint: options.useGlobalEndpoint ?? false,
        disableMultiregionAccessPoints: options.disableMultiregionAccessPoints ?? false,
        defaultSigningName: "s3",
    };
};
const commonParams = {
    ForcePathStyle: { type: "clientContextParams", name: "forcePathStyle" },
    UseArnRegion: { type: "clientContextParams", name: "useArnRegion" },
    DisableMultiRegionAccessPoints: { type: "clientContextParams", name: "disableMultiregionAccessPoints" },
    Accelerate: { type: "clientContextParams", name: "useAccelerateEndpoint" },
    DisableS3ExpressSessionAuth: { type: "clientContextParams", name: "disableS3ExpressSessionAuth" },
    UseGlobalEndpoint: { type: "builtInParams", name: "useGlobalEndpoint" },
    UseFIPS: { type: "builtInParams", name: "useFipsEndpoint" },
    Endpoint: { type: "builtInParams", name: "endpoint" },
    Region: { type: "builtInParams", name: "region" },
    UseDualStack: { type: "builtInParams", name: "useDualstackEndpoint" },
};

class S3ServiceException extends ServiceException {
    constructor(options) {
        super(options);
        Object.setPrototypeOf(this, S3ServiceException.prototype);
    }
}

class NoSuchUpload extends S3ServiceException {
    name = "NoSuchUpload";
    $fault = "client";
    constructor(opts) {
        super({
            name: "NoSuchUpload",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, NoSuchUpload.prototype);
    }
}
class ObjectNotInActiveTierError extends S3ServiceException {
    name = "ObjectNotInActiveTierError";
    $fault = "client";
    constructor(opts) {
        super({
            name: "ObjectNotInActiveTierError",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, ObjectNotInActiveTierError.prototype);
    }
}
class BucketAlreadyExists extends S3ServiceException {
    name = "BucketAlreadyExists";
    $fault = "client";
    constructor(opts) {
        super({
            name: "BucketAlreadyExists",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, BucketAlreadyExists.prototype);
    }
}
class BucketAlreadyOwnedByYou extends S3ServiceException {
    name = "BucketAlreadyOwnedByYou";
    $fault = "client";
    constructor(opts) {
        super({
            name: "BucketAlreadyOwnedByYou",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, BucketAlreadyOwnedByYou.prototype);
    }
}
class NoSuchBucket extends S3ServiceException {
    name = "NoSuchBucket";
    $fault = "client";
    constructor(opts) {
        super({
            name: "NoSuchBucket",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, NoSuchBucket.prototype);
    }
}
var AnalyticsFilter;
(function (AnalyticsFilter) {
    AnalyticsFilter.visit = (value, visitor) => {
        if (value.Prefix !== undefined)
            return visitor.Prefix(value.Prefix);
        if (value.Tag !== undefined)
            return visitor.Tag(value.Tag);
        if (value.And !== undefined)
            return visitor.And(value.And);
        return visitor._(value.$unknown[0], value.$unknown[1]);
    };
})(AnalyticsFilter || (AnalyticsFilter = {}));
var MetricsFilter;
(function (MetricsFilter) {
    MetricsFilter.visit = (value, visitor) => {
        if (value.Prefix !== undefined)
            return visitor.Prefix(value.Prefix);
        if (value.Tag !== undefined)
            return visitor.Tag(value.Tag);
        if (value.AccessPointArn !== undefined)
            return visitor.AccessPointArn(value.AccessPointArn);
        if (value.And !== undefined)
            return visitor.And(value.And);
        return visitor._(value.$unknown[0], value.$unknown[1]);
    };
})(MetricsFilter || (MetricsFilter = {}));
class InvalidObjectState extends S3ServiceException {
    name = "InvalidObjectState";
    $fault = "client";
    StorageClass;
    AccessTier;
    constructor(opts) {
        super({
            name: "InvalidObjectState",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, InvalidObjectState.prototype);
        this.StorageClass = opts.StorageClass;
        this.AccessTier = opts.AccessTier;
    }
}
class NoSuchKey extends S3ServiceException {
    name = "NoSuchKey";
    $fault = "client";
    constructor(opts) {
        super({
            name: "NoSuchKey",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, NoSuchKey.prototype);
    }
}
class NotFound extends S3ServiceException {
    name = "NotFound";
    $fault = "client";
    constructor(opts) {
        super({
            name: "NotFound",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, NotFound.prototype);
    }
}
const SessionCredentialsFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SecretAccessKey && { SecretAccessKey: SENSITIVE_STRING }),
    ...(obj.SessionToken && { SessionToken: SENSITIVE_STRING }),
});
const CreateSessionOutputFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SSEKMSKeyId && { SSEKMSKeyId: SENSITIVE_STRING }),
    ...(obj.SSEKMSEncryptionContext && { SSEKMSEncryptionContext: SENSITIVE_STRING }),
    ...(obj.Credentials && { Credentials: SessionCredentialsFilterSensitiveLog(obj.Credentials) }),
});
const CreateSessionRequestFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SSEKMSKeyId && { SSEKMSKeyId: SENSITIVE_STRING }),
    ...(obj.SSEKMSEncryptionContext && { SSEKMSEncryptionContext: SENSITIVE_STRING }),
});
const GetObjectOutputFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SSEKMSKeyId && { SSEKMSKeyId: SENSITIVE_STRING }),
});
const GetObjectRequestFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SSECustomerKey && { SSECustomerKey: SENSITIVE_STRING }),
});
const HeadObjectOutputFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SSEKMSKeyId && { SSEKMSKeyId: SENSITIVE_STRING }),
});
const HeadObjectRequestFilterSensitiveLog = (obj) => ({
    ...obj,
    ...(obj.SSECustomerKey && { SSECustomerKey: SENSITIVE_STRING }),
});

class EncryptionTypeMismatch extends S3ServiceException {
    name = "EncryptionTypeMismatch";
    $fault = "client";
    constructor(opts) {
        super({
            name: "EncryptionTypeMismatch",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, EncryptionTypeMismatch.prototype);
    }
}
class InvalidRequest extends S3ServiceException {
    name = "InvalidRequest";
    $fault = "client";
    constructor(opts) {
        super({
            name: "InvalidRequest",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, InvalidRequest.prototype);
    }
}
class InvalidWriteOffset extends S3ServiceException {
    name = "InvalidWriteOffset";
    $fault = "client";
    constructor(opts) {
        super({
            name: "InvalidWriteOffset",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, InvalidWriteOffset.prototype);
    }
}
class TooManyParts extends S3ServiceException {
    name = "TooManyParts";
    $fault = "client";
    constructor(opts) {
        super({
            name: "TooManyParts",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, TooManyParts.prototype);
    }
}
class ObjectAlreadyInActiveTierError extends S3ServiceException {
    name = "ObjectAlreadyInActiveTierError";
    $fault = "client";
    constructor(opts) {
        super({
            name: "ObjectAlreadyInActiveTierError",
            $fault: "client",
            ...opts,
        });
        Object.setPrototypeOf(this, ObjectAlreadyInActiveTierError.prototype);
    }
}
var SelectObjectContentEventStream;
(function (SelectObjectContentEventStream) {
    SelectObjectContentEventStream.visit = (value, visitor) => {
        if (value.Records !== undefined)
            return visitor.Records(value.Records);
        if (value.Stats !== undefined)
            return visitor.Stats(value.Stats);
        if (value.Progress !== undefined)
            return visitor.Progress(value.Progress);
        if (value.Cont !== undefined)
            return visitor.Cont(value.Cont);
        if (value.End !== undefined)
            return visitor.End(value.End);
        return visitor._(value.$unknown[0], value.$unknown[1]);
    };
})(SelectObjectContentEventStream || (SelectObjectContentEventStream = {}));

const se_CreateSessionCommand = async (input, context) => {
    const b = requestBuilder(input, context);
    const headers = map({}, isSerializableHeaderValue, {
        [_xacsm]: input[_SM],
        [_xasse]: input[_SSE],
        [_xasseakki]: input[_SSEKMSKI],
        [_xassec]: input[_SSEKMSEC],
        [_xassebke]: [() => isSerializableHeaderValue(input[_BKE]), () => input[_BKE].toString()],
    });
    b.bp("/");
    b.p("Bucket", () => input.Bucket, "{Bucket}", false);
    const query = map({
        [_s]: [, ""],
    });
    let body;
    b.m("GET").h(headers).q(query).b(body);
    return b.build();
};
const se_GetObjectCommand = async (input, context) => {
    const b = requestBuilder(input, context);
    const headers = map({}, isSerializableHeaderValue, {
        [_im]: input[_IM],
        [_ims]: [() => isSerializableHeaderValue(input[_IMSf]), () => dateToUtcString(input[_IMSf]).toString()],
        [_inm]: input[_INM],
        [_ius]: [() => isSerializableHeaderValue(input[_IUS]), () => dateToUtcString(input[_IUS]).toString()],
        [_ra]: input[_R],
        [_xasseca]: input[_SSECA],
        [_xasseck]: input[_SSECK],
        [_xasseckm]: input[_SSECKMD],
        [_xarp]: input[_RP],
        [_xaebo]: input[_EBO],
        [_xacm]: input[_CM],
    });
    b.bp("/{Key+}");
    b.p("Bucket", () => input.Bucket, "{Bucket}", false);
    b.p("Key", () => input.Key, "{Key+}", true);
    const query = map({
        [_xi]: [, "GetObject"],
        [_rcc]: [, input[_RCC]],
        [_rcd]: [, input[_RCD]],
        [_rce]: [, input[_RCE]],
        [_rcl]: [, input[_RCL]],
        [_rct]: [, input[_RCT]],
        [_re]: [() => input.ResponseExpires !== void 0, () => dateToUtcString(input[_RE]).toString()],
        [_vI]: [, input[_VI]],
        [_pN]: [() => input.PartNumber !== void 0, () => input[_PN].toString()],
    });
    let body;
    b.m("GET").h(headers).q(query).b(body);
    return b.build();
};
const se_HeadObjectCommand = async (input, context) => {
    const b = requestBuilder(input, context);
    const headers = map({}, isSerializableHeaderValue, {
        [_im]: input[_IM],
        [_ims]: [() => isSerializableHeaderValue(input[_IMSf]), () => dateToUtcString(input[_IMSf]).toString()],
        [_inm]: input[_INM],
        [_ius]: [() => isSerializableHeaderValue(input[_IUS]), () => dateToUtcString(input[_IUS]).toString()],
        [_ra]: input[_R],
        [_xasseca]: input[_SSECA],
        [_xasseck]: input[_SSECK],
        [_xasseckm]: input[_SSECKMD],
        [_xarp]: input[_RP],
        [_xaebo]: input[_EBO],
        [_xacm]: input[_CM],
    });
    b.bp("/{Key+}");
    b.p("Bucket", () => input.Bucket, "{Bucket}", false);
    b.p("Key", () => input.Key, "{Key+}", true);
    const query = map({
        [_rcc]: [, input[_RCC]],
        [_rcd]: [, input[_RCD]],
        [_rce]: [, input[_RCE]],
        [_rcl]: [, input[_RCL]],
        [_rct]: [, input[_RCT]],
        [_re]: [() => input.ResponseExpires !== void 0, () => dateToUtcString(input[_RE]).toString()],
        [_vI]: [, input[_VI]],
        [_pN]: [() => input.PartNumber !== void 0, () => input[_PN].toString()],
    });
    let body;
    b.m("HEAD").h(headers).q(query).b(body);
    return b.build();
};
const de_CreateSessionCommand = async (output, context) => {
    if (output.statusCode !== 200 && output.statusCode >= 300) {
        return de_CommandError(output, context);
    }
    const contents = map({
        $metadata: deserializeMetadata(output),
        [_SSE]: [, output.headers[_xasse]],
        [_SSEKMSKI]: [, output.headers[_xasseakki]],
        [_SSEKMSEC]: [, output.headers[_xassec]],
        [_BKE]: [() => void 0 !== output.headers[_xassebke], () => parseBoolean(output.headers[_xassebke])],
    });
    const data = expectNonNull(expectObject(await parseXmlBody(output.body, context)), "body");
    if (data[_C] != null) {
        contents[_C] = de_SessionCredentials(data[_C]);
    }
    return contents;
};
const de_GetObjectCommand = async (output, context) => {
    if (output.statusCode !== 200 && output.statusCode >= 300) {
        return de_CommandError(output, context);
    }
    const contents = map({
        $metadata: deserializeMetadata(output),
        [_DM]: [() => void 0 !== output.headers[_xadm], () => parseBoolean(output.headers[_xadm])],
        [_AR]: [, output.headers[_ar]],
        [_Exp]: [, output.headers[_xae]],
        [_Re]: [, output.headers[_xar]],
        [_LM]: [() => void 0 !== output.headers[_lm], () => expectNonNull(parseRfc7231DateTime(output.headers[_lm]))],
        [_CLo]: [() => void 0 !== output.headers[_cl_], () => strictParseLong(output.headers[_cl_])],
        [_ETa]: [, output.headers[_eta]],
        [_CCRC]: [, output.headers[_xacc]],
        [_CCRCC]: [, output.headers[_xacc_]],
        [_CCRCNVME]: [, output.headers[_xacc__]],
        [_CSHA]: [, output.headers[_xacs]],
        [_CSHAh]: [, output.headers[_xacs_]],
        [_CT]: [, output.headers[_xact]],
        [_MM]: [() => void 0 !== output.headers[_xamm], () => strictParseInt32(output.headers[_xamm])],
        [_VI]: [, output.headers[_xavi]],
        [_CC]: [, output.headers[_cc]],
        [_CD]: [, output.headers[_cd]],
        [_CE]: [, output.headers[_ce]],
        [_CL]: [, output.headers[_cl]],
        [_CR]: [, output.headers[_cr]],
        [_CTo]: [, output.headers[_ct]],
        [_E]: [() => void 0 !== output.headers[_e], () => expectNonNull(parseRfc7231DateTime(output.headers[_e]))],
        [_ES]: [, output.headers[_ex]],
        [_WRL]: [, output.headers[_xawrl]],
        [_SSE]: [, output.headers[_xasse]],
        [_SSECA]: [, output.headers[_xasseca]],
        [_SSECKMD]: [, output.headers[_xasseckm]],
        [_SSEKMSKI]: [, output.headers[_xasseakki]],
        [_BKE]: [() => void 0 !== output.headers[_xassebke], () => parseBoolean(output.headers[_xassebke])],
        [_SC]: [, output.headers[_xasc]],
        [_RC]: [, output.headers[_xarc]],
        [_RS]: [, output.headers[_xars]],
        [_PC]: [() => void 0 !== output.headers[_xampc], () => strictParseInt32(output.headers[_xampc])],
        [_TC]: [() => void 0 !== output.headers[_xatc], () => strictParseInt32(output.headers[_xatc])],
        [_OLM]: [, output.headers[_xaolm]],
        [_OLRUD]: [
            () => void 0 !== output.headers[_xaolrud],
            () => expectNonNull(parseRfc3339DateTimeWithOffset(output.headers[_xaolrud])),
        ],
        [_OLLHS]: [, output.headers[_xaollh]],
        Metadata: [
            ,
            Object.keys(output.headers)
                .filter((header) => header.startsWith("x-amz-meta-"))
                .reduce((acc, header) => {
                acc[header.substring(11)] = output.headers[header];
                return acc;
            }, {}),
        ],
    });
    const data = output.body;
    context.sdkStreamMixin(data);
    contents.Body = data;
    return contents;
};
const de_HeadObjectCommand = async (output, context) => {
    if (output.statusCode !== 200 && output.statusCode >= 300) {
        return de_CommandError(output, context);
    }
    const contents = map({
        $metadata: deserializeMetadata(output),
        [_DM]: [() => void 0 !== output.headers[_xadm], () => parseBoolean(output.headers[_xadm])],
        [_AR]: [, output.headers[_ar]],
        [_Exp]: [, output.headers[_xae]],
        [_Re]: [, output.headers[_xar]],
        [_AS]: [, output.headers[_xaas]],
        [_LM]: [() => void 0 !== output.headers[_lm], () => expectNonNull(parseRfc7231DateTime(output.headers[_lm]))],
        [_CLo]: [() => void 0 !== output.headers[_cl_], () => strictParseLong(output.headers[_cl_])],
        [_CCRC]: [, output.headers[_xacc]],
        [_CCRCC]: [, output.headers[_xacc_]],
        [_CCRCNVME]: [, output.headers[_xacc__]],
        [_CSHA]: [, output.headers[_xacs]],
        [_CSHAh]: [, output.headers[_xacs_]],
        [_CT]: [, output.headers[_xact]],
        [_ETa]: [, output.headers[_eta]],
        [_MM]: [() => void 0 !== output.headers[_xamm], () => strictParseInt32(output.headers[_xamm])],
        [_VI]: [, output.headers[_xavi]],
        [_CC]: [, output.headers[_cc]],
        [_CD]: [, output.headers[_cd]],
        [_CE]: [, output.headers[_ce]],
        [_CL]: [, output.headers[_cl]],
        [_CTo]: [, output.headers[_ct]],
        [_E]: [() => void 0 !== output.headers[_e], () => expectNonNull(parseRfc7231DateTime(output.headers[_e]))],
        [_ES]: [, output.headers[_ex]],
        [_WRL]: [, output.headers[_xawrl]],
        [_SSE]: [, output.headers[_xasse]],
        [_SSECA]: [, output.headers[_xasseca]],
        [_SSECKMD]: [, output.headers[_xasseckm]],
        [_SSEKMSKI]: [, output.headers[_xasseakki]],
        [_BKE]: [() => void 0 !== output.headers[_xassebke], () => parseBoolean(output.headers[_xassebke])],
        [_SC]: [, output.headers[_xasc]],
        [_RC]: [, output.headers[_xarc]],
        [_RS]: [, output.headers[_xars]],
        [_PC]: [() => void 0 !== output.headers[_xampc], () => strictParseInt32(output.headers[_xampc])],
        [_OLM]: [, output.headers[_xaolm]],
        [_OLRUD]: [
            () => void 0 !== output.headers[_xaolrud],
            () => expectNonNull(parseRfc3339DateTimeWithOffset(output.headers[_xaolrud])),
        ],
        [_OLLHS]: [, output.headers[_xaollh]],
        Metadata: [
            ,
            Object.keys(output.headers)
                .filter((header) => header.startsWith("x-amz-meta-"))
                .reduce((acc, header) => {
                acc[header.substring(11)] = output.headers[header];
                return acc;
            }, {}),
        ],
    });
    await collectBody$1(output.body, context);
    return contents;
};
const de_CommandError = async (output, context) => {
    const parsedOutput = {
        ...output,
        body: await parseXmlErrorBody(output.body, context),
    };
    const errorCode = loadRestXmlErrorCode(output, parsedOutput.body);
    switch (errorCode) {
        case "NoSuchUpload":
        case "com.amazonaws.s3#NoSuchUpload":
            throw await de_NoSuchUploadRes(parsedOutput);
        case "ObjectNotInActiveTierError":
        case "com.amazonaws.s3#ObjectNotInActiveTierError":
            throw await de_ObjectNotInActiveTierErrorRes(parsedOutput);
        case "BucketAlreadyExists":
        case "com.amazonaws.s3#BucketAlreadyExists":
            throw await de_BucketAlreadyExistsRes(parsedOutput);
        case "BucketAlreadyOwnedByYou":
        case "com.amazonaws.s3#BucketAlreadyOwnedByYou":
            throw await de_BucketAlreadyOwnedByYouRes(parsedOutput);
        case "NoSuchBucket":
        case "com.amazonaws.s3#NoSuchBucket":
            throw await de_NoSuchBucketRes(parsedOutput);
        case "InvalidObjectState":
        case "com.amazonaws.s3#InvalidObjectState":
            throw await de_InvalidObjectStateRes(parsedOutput);
        case "NoSuchKey":
        case "com.amazonaws.s3#NoSuchKey":
            throw await de_NoSuchKeyRes(parsedOutput);
        case "NotFound":
        case "com.amazonaws.s3#NotFound":
            throw await de_NotFoundRes(parsedOutput);
        case "EncryptionTypeMismatch":
        case "com.amazonaws.s3#EncryptionTypeMismatch":
            throw await de_EncryptionTypeMismatchRes(parsedOutput);
        case "InvalidRequest":
        case "com.amazonaws.s3#InvalidRequest":
            throw await de_InvalidRequestRes(parsedOutput);
        case "InvalidWriteOffset":
        case "com.amazonaws.s3#InvalidWriteOffset":
            throw await de_InvalidWriteOffsetRes(parsedOutput);
        case "TooManyParts":
        case "com.amazonaws.s3#TooManyParts":
            throw await de_TooManyPartsRes(parsedOutput);
        case "ObjectAlreadyInActiveTierError":
        case "com.amazonaws.s3#ObjectAlreadyInActiveTierError":
            throw await de_ObjectAlreadyInActiveTierErrorRes(parsedOutput);
        default:
            const parsedBody = parsedOutput.body;
            return throwDefaultError({
                output,
                parsedBody,
                errorCode,
            });
    }
};
const throwDefaultError = withBaseException(S3ServiceException);
const de_BucketAlreadyExistsRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new BucketAlreadyExists({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_BucketAlreadyOwnedByYouRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new BucketAlreadyOwnedByYou({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_EncryptionTypeMismatchRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new EncryptionTypeMismatch({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_InvalidObjectStateRes = async (parsedOutput, context) => {
    const contents = map({});
    const data = parsedOutput.body;
    if (data[_AT] != null) {
        contents[_AT] = expectString(data[_AT]);
    }
    if (data[_SC] != null) {
        contents[_SC] = expectString(data[_SC]);
    }
    const exception = new InvalidObjectState({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_InvalidRequestRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new InvalidRequest({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_InvalidWriteOffsetRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new InvalidWriteOffset({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_NoSuchBucketRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new NoSuchBucket({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_NoSuchKeyRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new NoSuchKey({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_NoSuchUploadRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new NoSuchUpload({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_NotFoundRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new NotFound({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_ObjectAlreadyInActiveTierErrorRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new ObjectAlreadyInActiveTierError({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_ObjectNotInActiveTierErrorRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new ObjectNotInActiveTierError({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_TooManyPartsRes = async (parsedOutput, context) => {
    const contents = map({});
    parsedOutput.body;
    const exception = new TooManyParts({
        $metadata: deserializeMetadata(parsedOutput),
        ...contents,
    });
    return decorateServiceException(exception, parsedOutput.body);
};
const de_SessionCredentials = (output, context) => {
    const contents = {};
    if (output[_AKI] != null) {
        contents[_AKI] = expectString(output[_AKI]);
    }
    if (output[_SAK] != null) {
        contents[_SAK] = expectString(output[_SAK]);
    }
    if (output[_ST] != null) {
        contents[_ST] = expectString(output[_ST]);
    }
    if (output[_Exp] != null) {
        contents[_Exp] = expectNonNull(parseRfc3339DateTimeWithOffset(output[_Exp]));
    }
    return contents;
};
const deserializeMetadata = (output) => ({
    httpStatusCode: output.statusCode,
    requestId: output.headers["x-amzn-requestid"] ?? output.headers["x-amzn-request-id"] ?? output.headers["x-amz-request-id"],
    extendedRequestId: output.headers["x-amz-id-2"],
    cfId: output.headers["x-amz-cf-id"],
});
const _AKI = "AccessKeyId";
const _AR = "AcceptRanges";
const _AS = "ArchiveStatus";
const _AT = "AccessTier";
const _BKE = "BucketKeyEnabled";
const _C = "Credentials";
const _CC = "CacheControl";
const _CCRC = "ChecksumCRC32";
const _CCRCC = "ChecksumCRC32C";
const _CCRCNVME = "ChecksumCRC64NVME";
const _CD = "ContentDisposition";
const _CE = "ContentEncoding";
const _CL = "ContentLanguage";
const _CLo = "ContentLength";
const _CM = "ChecksumMode";
const _CR = "ContentRange";
const _CSHA = "ChecksumSHA1";
const _CSHAh = "ChecksumSHA256";
const _CT = "ChecksumType";
const _CTo = "ContentType";
const _DM = "DeleteMarker";
const _E = "Expires";
const _EBO = "ExpectedBucketOwner";
const _ES = "ExpiresString";
const _ETa = "ETag";
const _Exp = "Expiration";
const _IM = "IfMatch";
const _IMSf = "IfModifiedSince";
const _INM = "IfNoneMatch";
const _IUS = "IfUnmodifiedSince";
const _LM = "LastModified";
const _MM = "MissingMeta";
const _OLLHS = "ObjectLockLegalHoldStatus";
const _OLM = "ObjectLockMode";
const _OLRUD = "ObjectLockRetainUntilDate";
const _PC = "PartsCount";
const _PN = "PartNumber";
const _R = "Range";
const _RC = "RequestCharged";
const _RCC = "ResponseCacheControl";
const _RCD = "ResponseContentDisposition";
const _RCE = "ResponseContentEncoding";
const _RCL = "ResponseContentLanguage";
const _RCT = "ResponseContentType";
const _RE = "ResponseExpires";
const _RP = "RequestPayer";
const _RS = "ReplicationStatus";
const _Re = "Restore";
const _SAK = "SecretAccessKey";
const _SC = "StorageClass";
const _SM = "SessionMode";
const _SSE = "ServerSideEncryption";
const _SSECA = "SSECustomerAlgorithm";
const _SSECK = "SSECustomerKey";
const _SSECKMD = "SSECustomerKeyMD5";
const _SSEKMSEC = "SSEKMSEncryptionContext";
const _SSEKMSKI = "SSEKMSKeyId";
const _ST = "SessionToken";
const _TC = "TagCount";
const _VI = "VersionId";
const _WRL = "WebsiteRedirectLocation";
const _ar = "accept-ranges";
const _cc = "cache-control";
const _cd = "content-disposition";
const _ce = "content-encoding";
const _cl = "content-language";
const _cl_ = "content-length";
const _cr = "content-range";
const _ct = "content-type";
const _e = "expires";
const _eta = "etag";
const _ex = "expiresstring";
const _im = "if-match";
const _ims = "if-modified-since";
const _inm = "if-none-match";
const _ius = "if-unmodified-since";
const _lm = "last-modified";
const _pN = "partNumber";
const _ra = "range";
const _rcc = "response-cache-control";
const _rcd = "response-content-disposition";
const _rce = "response-content-encoding";
const _rcl = "response-content-language";
const _rct = "response-content-type";
const _re = "response-expires";
const _s = "session";
const _vI = "versionId";
const _xaas = "x-amz-archive-status";
const _xacc = "x-amz-checksum-crc32";
const _xacc_ = "x-amz-checksum-crc32c";
const _xacc__ = "x-amz-checksum-crc64nvme";
const _xacm = "x-amz-checksum-mode";
const _xacs = "x-amz-checksum-sha1";
const _xacs_ = "x-amz-checksum-sha256";
const _xacsm = "x-amz-create-session-mode";
const _xact = "x-amz-checksum-type";
const _xadm = "x-amz-delete-marker";
const _xae = "x-amz-expiration";
const _xaebo = "x-amz-expected-bucket-owner";
const _xamm = "x-amz-missing-meta";
const _xampc = "x-amz-mp-parts-count";
const _xaollh = "x-amz-object-lock-legal-hold";
const _xaolm = "x-amz-object-lock-mode";
const _xaolrud = "x-amz-object-lock-retain-until-date";
const _xar = "x-amz-restore";
const _xarc = "x-amz-request-charged";
const _xarp = "x-amz-request-payer";
const _xars = "x-amz-replication-status";
const _xasc = "x-amz-storage-class";
const _xasse = "x-amz-server-side-encryption";
const _xasseakki = "x-amz-server-side-encryption-aws-kms-key-id";
const _xassebke = "x-amz-server-side-encryption-bucket-key-enabled";
const _xassec = "x-amz-server-side-encryption-context";
const _xasseca = "x-amz-server-side-encryption-customer-algorithm";
const _xasseck = "x-amz-server-side-encryption-customer-key";
const _xasseckm = "x-amz-server-side-encryption-customer-key-md5";
const _xatc = "x-amz-tagging-count";
const _xavi = "x-amz-version-id";
const _xawrl = "x-amz-website-redirect-location";
const _xi = "x-id";

class CreateSessionCommand extends Command
    .classBuilder()
    .ep({
    ...commonParams,
    DisableS3ExpressSessionAuth: { type: "staticContextParams", value: true },
    Bucket: { type: "contextParams", name: "Bucket" },
})
    .m(function (Command, cs, config, o) {
    return [
        getSerdePlugin(config, this.serialize, this.deserialize),
        getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
        getThrow200ExceptionsPlugin(config),
    ];
})
    .s("AmazonS3", "CreateSession", {})
    .n("S3Client", "CreateSessionCommand")
    .f(CreateSessionRequestFilterSensitiveLog, CreateSessionOutputFilterSensitiveLog)
    .ser(se_CreateSessionCommand)
    .de(de_CreateSessionCommand)
    .build() {
}

var name = "@aws-sdk/client-s3";
var description = "AWS SDK for JavaScript S3 Client for Node.js, Browser and React Native";
var version = "3.744.0";
var scripts = {
	build: "concurrently 'yarn:build:cjs' 'yarn:build:es' 'yarn:build:types'",
	"build:cjs": "node ../../scripts/compilation/inline client-s3",
	"build:es": "tsc -p tsconfig.es.json",
	"build:include:deps": "lerna run --scope $npm_package_name --include-dependencies build",
	"build:types": "tsc -p tsconfig.types.json",
	"build:types:downlevel": "downlevel-dts dist-types dist-types/ts3.4",
	clean: "rimraf ./dist-* && rimraf *.tsbuildinfo",
	"extract:docs": "api-extractor run --local",
	"generate:client": "node ../../scripts/generate-clients/single-service --solo s3",
	test: "yarn g:vitest run",
	"test:browser": "node ./test/browser-build/esbuild && yarn g:vitest run -c vitest.config.browser.ts",
	"test:browser:watch": "node ./test/browser-build/esbuild && yarn g:vitest watch -c vitest.config.browser.ts",
	"test:e2e": "yarn g:vitest run -c vitest.config.e2e.ts && yarn test:browser",
	"test:e2e:watch": "yarn g:vitest watch -c vitest.config.e2e.ts",
	"test:watch": "yarn g:vitest watch"
};
var main = "./dist-cjs/index.js";
var types = "./dist-types/index.d.ts";
var module = "./dist-es/index.js";
var sideEffects = false;
var dependencies = {
	"@aws-crypto/sha1-browser": "5.2.0",
	"@aws-crypto/sha256-browser": "5.2.0",
	"@aws-crypto/sha256-js": "5.2.0",
	"@aws-sdk/core": "3.744.0",
	"@aws-sdk/credential-provider-node": "3.744.0",
	"@aws-sdk/middleware-bucket-endpoint": "3.734.0",
	"@aws-sdk/middleware-expect-continue": "3.734.0",
	"@aws-sdk/middleware-flexible-checksums": "3.744.0",
	"@aws-sdk/middleware-host-header": "3.734.0",
	"@aws-sdk/middleware-location-constraint": "3.734.0",
	"@aws-sdk/middleware-logger": "3.734.0",
	"@aws-sdk/middleware-recursion-detection": "3.734.0",
	"@aws-sdk/middleware-sdk-s3": "3.744.0",
	"@aws-sdk/middleware-ssec": "3.734.0",
	"@aws-sdk/middleware-user-agent": "3.744.0",
	"@aws-sdk/region-config-resolver": "3.734.0",
	"@aws-sdk/signature-v4-multi-region": "3.744.0",
	"@aws-sdk/types": "3.734.0",
	"@aws-sdk/util-endpoints": "3.743.0",
	"@aws-sdk/util-user-agent-browser": "3.734.0",
	"@aws-sdk/util-user-agent-node": "3.744.0",
	"@aws-sdk/xml-builder": "3.734.0",
	"@smithy/config-resolver": "^4.0.1",
	"@smithy/core": "^3.1.2",
	"@smithy/eventstream-serde-browser": "^4.0.1",
	"@smithy/eventstream-serde-config-resolver": "^4.0.1",
	"@smithy/eventstream-serde-node": "^4.0.1",
	"@smithy/fetch-http-handler": "^5.0.1",
	"@smithy/hash-blob-browser": "^4.0.1",
	"@smithy/hash-node": "^4.0.1",
	"@smithy/hash-stream-node": "^4.0.1",
	"@smithy/invalid-dependency": "^4.0.1",
	"@smithy/md5-js": "^4.0.1",
	"@smithy/middleware-content-length": "^4.0.1",
	"@smithy/middleware-endpoint": "^4.0.3",
	"@smithy/middleware-retry": "^4.0.4",
	"@smithy/middleware-serde": "^4.0.2",
	"@smithy/middleware-stack": "^4.0.1",
	"@smithy/node-config-provider": "^4.0.1",
	"@smithy/node-http-handler": "^4.0.2",
	"@smithy/protocol-http": "^5.0.1",
	"@smithy/smithy-client": "^4.1.3",
	"@smithy/types": "^4.1.0",
	"@smithy/url-parser": "^4.0.1",
	"@smithy/util-base64": "^4.0.0",
	"@smithy/util-body-length-browser": "^4.0.0",
	"@smithy/util-body-length-node": "^4.0.0",
	"@smithy/util-defaults-mode-browser": "^4.0.4",
	"@smithy/util-defaults-mode-node": "^4.0.4",
	"@smithy/util-endpoints": "^3.0.1",
	"@smithy/util-middleware": "^4.0.1",
	"@smithy/util-retry": "^4.0.1",
	"@smithy/util-stream": "^4.0.2",
	"@smithy/util-utf8": "^4.0.0",
	"@smithy/util-waiter": "^4.0.2",
	tslib: "^2.6.2"
};
var devDependencies = {
	"@aws-sdk/signature-v4-crt": "3.744.0",
	"@tsconfig/node18": "18.2.4",
	"@types/node": "^18.19.69",
	concurrently: "7.0.0",
	"downlevel-dts": "0.10.1",
	rimraf: "3.0.2",
	typescript: "~5.2.2"
};
var engines = {
	node: ">=18.0.0"
};
var typesVersions = {
	"<4.0": {
		"dist-types/*": [
			"dist-types/ts3.4/*"
		]
	}
};
var files = [
	"dist-*/**"
];
var author = {
	name: "AWS SDK for JavaScript Team",
	url: "https://aws.amazon.com/javascript/"
};
var license = "Apache-2.0";
var browser = {
	"./dist-es/runtimeConfig": "./dist-es/runtimeConfig.browser"
};
var homepage = "https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3";
var repository = {
	type: "git",
	url: "https://github.com/aws/aws-sdk-js-v3.git",
	directory: "clients/client-s3"
};
var packageInfo = {
	name: name,
	description: description,
	version: version,
	scripts: scripts,
	main: main,
	types: types,
	module: module,
	sideEffects: sideEffects,
	dependencies: dependencies,
	devDependencies: devDependencies,
	engines: engines,
	typesVersions: typesVersions,
	files: files,
	author: author,
	license: license,
	browser: browser,
	"react-native": {
	"./dist-es/runtimeConfig": "./dist-es/runtimeConfig.native"
},
	homepage: homepage,
	repository: repository
};

const ENV_KEY = "AWS_ACCESS_KEY_ID";
const ENV_SECRET = "AWS_SECRET_ACCESS_KEY";
const ENV_SESSION = "AWS_SESSION_TOKEN";
const ENV_EXPIRATION = "AWS_CREDENTIAL_EXPIRATION";
const ENV_CREDENTIAL_SCOPE = "AWS_CREDENTIAL_SCOPE";
const ENV_ACCOUNT_ID = "AWS_ACCOUNT_ID";
const fromEnv = (init) => async () => {
    init?.logger?.debug("@aws-sdk/credential-provider-env - fromEnv");
    const accessKeyId = process.env[ENV_KEY];
    const secretAccessKey = process.env[ENV_SECRET];
    const sessionToken = process.env[ENV_SESSION];
    const expiry = process.env[ENV_EXPIRATION];
    const credentialScope = process.env[ENV_CREDENTIAL_SCOPE];
    const accountId = process.env[ENV_ACCOUNT_ID];
    if (accessKeyId && secretAccessKey) {
        const credentials = {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken && { sessionToken }),
            ...(expiry && { expiration: new Date(expiry) }),
            ...(credentialScope && { credentialScope }),
            ...(accountId && { accountId }),
        };
        setCredentialFeature(credentials, "CREDENTIALS_ENV_VARS", "g");
        return credentials;
    }
    throw new CredentialsProviderError("Unable to find environment variable credentials.", { logger: init?.logger });
};

var index = /*#__PURE__*/Object.freeze({
  __proto__: null,
  ENV_KEY: ENV_KEY,
  ENV_SECRET: ENV_SECRET,
  ENV_SESSION: ENV_SESSION,
  ENV_EXPIRATION: ENV_EXPIRATION,
  ENV_CREDENTIAL_SCOPE: ENV_CREDENTIAL_SCOPE,
  ENV_ACCOUNT_ID: ENV_ACCOUNT_ID,
  fromEnv: fromEnv
});

const ENV_IMDS_DISABLED$1 = "AWS_EC2_METADATA_DISABLED";
const remoteProvider = async (init) => {
    const { ENV_CMDS_FULL_URI, ENV_CMDS_RELATIVE_URI, fromContainerMetadata, fromInstanceMetadata } = await import('./index5.mjs');
    if (process.env[ENV_CMDS_RELATIVE_URI] || process.env[ENV_CMDS_FULL_URI]) {
        init.logger?.debug("@aws-sdk/credential-provider-node - remoteProvider::fromHttp/fromContainerMetadata");
        const { fromHttp } = await import('./index6.mjs');
        return chain(fromHttp(init), fromContainerMetadata(init));
    }
    if (process.env[ENV_IMDS_DISABLED$1] && process.env[ENV_IMDS_DISABLED$1] !== "false") {
        return async () => {
            throw new CredentialsProviderError("EC2 Instance Metadata Service access disabled", { logger: init.logger });
        };
    }
    init.logger?.debug("@aws-sdk/credential-provider-node - remoteProvider::fromInstanceMetadata");
    return fromInstanceMetadata(init);
};

let multipleCredentialSourceWarningEmitted = false;
const defaultProvider = (init = {}) => memoize(chain(async () => {
    const profile = init.profile ?? process.env[ENV_PROFILE];
    if (profile) {
        const envStaticCredentialsAreSet = process.env[ENV_KEY] && process.env[ENV_SECRET];
        if (envStaticCredentialsAreSet) {
            if (!multipleCredentialSourceWarningEmitted) {
                const warnFn = init.logger?.warn && init.logger?.constructor?.name !== "NoOpLogger" ? init.logger.warn : console.warn;
                warnFn(`@aws-sdk/credential-provider-node - defaultProvider::fromEnv WARNING:
    Multiple credential sources detected: 
    Both AWS_PROFILE and the pair AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY static credentials are set.
    This SDK will proceed with the AWS_PROFILE value.
    
    However, a future version may change this behavior to prefer the ENV static credentials.
    Please ensure that your environment only sets either the AWS_PROFILE or the
    AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair.
`);
                multipleCredentialSourceWarningEmitted = true;
            }
        }
        throw new CredentialsProviderError("AWS_PROFILE is set, skipping fromEnv provider.", {
            logger: init.logger,
            tryNextLink: true,
        });
    }
    init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromEnv");
    return fromEnv(init)();
}, async () => {
    init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromSSO");
    const { ssoStartUrl, ssoAccountId, ssoRegion, ssoRoleName, ssoSession } = init;
    if (!ssoStartUrl && !ssoAccountId && !ssoRegion && !ssoRoleName && !ssoSession) {
        throw new CredentialsProviderError("Skipping SSO provider in default chain (inputs do not include SSO fields).", { logger: init.logger });
    }
    const { fromSSO } = await import('./index.mjs');
    return fromSSO(init)();
}, async () => {
    init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromIni");
    const { fromIni } = await import('./index2.mjs');
    return fromIni(init)();
}, async () => {
    init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromProcess");
    const { fromProcess } = await import('./index3.mjs');
    return fromProcess(init)();
}, async () => {
    init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromTokenFile");
    const { fromTokenFile } = await import('./index4.mjs');
    return fromTokenFile(init)();
}, async () => {
    init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::remoteProvider");
    return (await remoteProvider(init))();
}, async () => {
    throw new CredentialsProviderError("Could not load credentials from any providers", {
        tryNextLink: false,
        logger: init.logger,
    });
}), credentialsTreatedAsExpired, credentialsWillNeedRefresh);
const credentialsWillNeedRefresh = (credentials) => credentials?.expiration !== undefined;
const credentialsTreatedAsExpired = (credentials) => credentials?.expiration !== undefined && credentials.expiration.getTime() - Date.now() < 300000;

const NODE_USE_ARN_REGION_ENV_NAME = "AWS_S3_USE_ARN_REGION";
const NODE_USE_ARN_REGION_INI_NAME = "s3_use_arn_region";
const NODE_USE_ARN_REGION_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => booleanSelector(env, NODE_USE_ARN_REGION_ENV_NAME, SelectorType.ENV),
    configFileSelector: (profile) => booleanSelector(profile, NODE_USE_ARN_REGION_INI_NAME, SelectorType.CONFIG),
    default: false,
};

const isCrtAvailable = () => {
    return null;
};

const createDefaultUserAgentProvider = ({ serviceId, clientVersion }) => {
    return async (config) => {
        const sections = [
            ["aws-sdk-js", clientVersion],
            ["ua", "2.1"],
            [`os/${platform()}`, release()],
            ["lang/js"],
            ["md/nodejs", `${versions.node}`],
        ];
        const crtAvailable = isCrtAvailable();
        if (crtAvailable) {
            sections.push(crtAvailable);
        }
        if (serviceId) {
            sections.push([`api/${serviceId}`, clientVersion]);
        }
        if (env.AWS_EXECUTION_ENV) {
            sections.push([`exec-env/${env.AWS_EXECUTION_ENV}`]);
        }
        const appId = await config?.userAgentAppId?.();
        const resolvedUserAgent = appId ? [...sections, [`app/${appId}`]] : [...sections];
        return resolvedUserAgent;
    };
};

const UA_APP_ID_ENV_NAME = "AWS_SDK_UA_APP_ID";
const UA_APP_ID_INI_NAME = "sdk_ua_app_id";
const UA_APP_ID_INI_NAME_DEPRECATED = "sdk-ua-app-id";
const NODE_APP_ID_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => env[UA_APP_ID_ENV_NAME],
    configFileSelector: (profile) => profile[UA_APP_ID_INI_NAME] ?? profile[UA_APP_ID_INI_NAME_DEPRECATED],
    default: DEFAULT_UA_APP_ID,
};

class Int64 {
    constructor(bytes) {
        this.bytes = bytes;
        if (bytes.byteLength !== 8) {
            throw new Error("Int64 buffers must be exactly 8 bytes");
        }
    }
    static fromNumber(number) {
        if (number > 9223372036854776000 || number < -9223372036854776000) {
            throw new Error(`${number} is too large (or, if negative, too small) to represent as an Int64`);
        }
        const bytes = new Uint8Array(8);
        for (let i = 7, remaining = Math.abs(Math.round(number)); i > -1 && remaining > 0; i--, remaining /= 256) {
            bytes[i] = remaining;
        }
        if (number < 0) {
            negate(bytes);
        }
        return new Int64(bytes);
    }
    valueOf() {
        const bytes = this.bytes.slice(0);
        const negative = bytes[0] & 0b10000000;
        if (negative) {
            negate(bytes);
        }
        return parseInt(toHex(bytes), 16) * (negative ? -1 : 1);
    }
    toString() {
        return String(this.valueOf());
    }
}
function negate(bytes) {
    for (let i = 0; i < 8; i++) {
        bytes[i] ^= 0xff;
    }
    for (let i = 7; i > -1; i--) {
        bytes[i]++;
        if (bytes[i] !== 0)
            break;
    }
}

class HeaderMarshaller {
    constructor(toUtf8, fromUtf8) {
        this.toUtf8 = toUtf8;
        this.fromUtf8 = fromUtf8;
    }
    format(headers) {
        const chunks = [];
        for (const headerName of Object.keys(headers)) {
            const bytes = this.fromUtf8(headerName);
            chunks.push(Uint8Array.from([bytes.byteLength]), bytes, this.formatHeaderValue(headers[headerName]));
        }
        const out = new Uint8Array(chunks.reduce((carry, bytes) => carry + bytes.byteLength, 0));
        let position = 0;
        for (const chunk of chunks) {
            out.set(chunk, position);
            position += chunk.byteLength;
        }
        return out;
    }
    formatHeaderValue(header) {
        switch (header.type) {
            case "boolean":
                return Uint8Array.from([header.value ? 0 : 1]);
            case "byte":
                return Uint8Array.from([2, header.value]);
            case "short":
                const shortView = new DataView(new ArrayBuffer(3));
                shortView.setUint8(0, 3);
                shortView.setInt16(1, header.value, false);
                return new Uint8Array(shortView.buffer);
            case "integer":
                const intView = new DataView(new ArrayBuffer(5));
                intView.setUint8(0, 4);
                intView.setInt32(1, header.value, false);
                return new Uint8Array(intView.buffer);
            case "long":
                const longBytes = new Uint8Array(9);
                longBytes[0] = 5;
                longBytes.set(header.value.bytes, 1);
                return longBytes;
            case "binary":
                const binView = new DataView(new ArrayBuffer(3 + header.value.byteLength));
                binView.setUint8(0, 6);
                binView.setUint16(1, header.value.byteLength, false);
                const binBytes = new Uint8Array(binView.buffer);
                binBytes.set(header.value, 3);
                return binBytes;
            case "string":
                const utf8Bytes = this.fromUtf8(header.value);
                const strView = new DataView(new ArrayBuffer(3 + utf8Bytes.byteLength));
                strView.setUint8(0, 7);
                strView.setUint16(1, utf8Bytes.byteLength, false);
                const strBytes = new Uint8Array(strView.buffer);
                strBytes.set(utf8Bytes, 3);
                return strBytes;
            case "timestamp":
                const tsBytes = new Uint8Array(9);
                tsBytes[0] = 8;
                tsBytes.set(Int64.fromNumber(header.value.valueOf()).bytes, 1);
                return tsBytes;
            case "uuid":
                if (!UUID_PATTERN.test(header.value)) {
                    throw new Error(`Invalid UUID received: ${header.value}`);
                }
                const uuidBytes = new Uint8Array(17);
                uuidBytes[0] = 9;
                uuidBytes.set(fromHex(header.value.replace(/\-/g, "")), 1);
                return uuidBytes;
        }
    }
    parse(headers) {
        const out = {};
        let position = 0;
        while (position < headers.byteLength) {
            const nameLength = headers.getUint8(position++);
            const name = this.toUtf8(new Uint8Array(headers.buffer, headers.byteOffset + position, nameLength));
            position += nameLength;
            switch (headers.getUint8(position++)) {
                case 0:
                    out[name] = {
                        type: BOOLEAN_TAG,
                        value: true,
                    };
                    break;
                case 1:
                    out[name] = {
                        type: BOOLEAN_TAG,
                        value: false,
                    };
                    break;
                case 2:
                    out[name] = {
                        type: BYTE_TAG,
                        value: headers.getInt8(position++),
                    };
                    break;
                case 3:
                    out[name] = {
                        type: SHORT_TAG,
                        value: headers.getInt16(position, false),
                    };
                    position += 2;
                    break;
                case 4:
                    out[name] = {
                        type: INT_TAG,
                        value: headers.getInt32(position, false),
                    };
                    position += 4;
                    break;
                case 5:
                    out[name] = {
                        type: LONG_TAG,
                        value: new Int64(new Uint8Array(headers.buffer, headers.byteOffset + position, 8)),
                    };
                    position += 8;
                    break;
                case 6:
                    const binaryLength = headers.getUint16(position, false);
                    position += 2;
                    out[name] = {
                        type: BINARY_TAG,
                        value: new Uint8Array(headers.buffer, headers.byteOffset + position, binaryLength),
                    };
                    position += binaryLength;
                    break;
                case 7:
                    const stringLength = headers.getUint16(position, false);
                    position += 2;
                    out[name] = {
                        type: STRING_TAG,
                        value: this.toUtf8(new Uint8Array(headers.buffer, headers.byteOffset + position, stringLength)),
                    };
                    position += stringLength;
                    break;
                case 8:
                    out[name] = {
                        type: TIMESTAMP_TAG,
                        value: new Date(new Int64(new Uint8Array(headers.buffer, headers.byteOffset + position, 8)).valueOf()),
                    };
                    position += 8;
                    break;
                case 9:
                    const uuidBytes = new Uint8Array(headers.buffer, headers.byteOffset + position, 16);
                    position += 16;
                    out[name] = {
                        type: UUID_TAG,
                        value: `${toHex(uuidBytes.subarray(0, 4))}-${toHex(uuidBytes.subarray(4, 6))}-${toHex(uuidBytes.subarray(6, 8))}-${toHex(uuidBytes.subarray(8, 10))}-${toHex(uuidBytes.subarray(10))}`,
                    };
                    break;
                default:
                    throw new Error(`Unrecognized header type tag`);
            }
        }
        return out;
    }
}
var HEADER_VALUE_TYPE;
(function (HEADER_VALUE_TYPE) {
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["boolTrue"] = 0] = "boolTrue";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["boolFalse"] = 1] = "boolFalse";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["byte"] = 2] = "byte";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["short"] = 3] = "short";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["integer"] = 4] = "integer";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["long"] = 5] = "long";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["byteArray"] = 6] = "byteArray";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["string"] = 7] = "string";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["timestamp"] = 8] = "timestamp";
    HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["uuid"] = 9] = "uuid";
})(HEADER_VALUE_TYPE || (HEADER_VALUE_TYPE = {}));
const BOOLEAN_TAG = "boolean";
const BYTE_TAG = "byte";
const SHORT_TAG = "short";
const INT_TAG = "integer";
const LONG_TAG = "long";
const BINARY_TAG = "binary";
const STRING_TAG = "string";
const TIMESTAMP_TAG = "timestamp";
const UUID_TAG = "uuid";
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const PRELUDE_MEMBER_LENGTH = 4;
const PRELUDE_LENGTH = PRELUDE_MEMBER_LENGTH * 2;
const CHECKSUM_LENGTH = 4;
const MINIMUM_MESSAGE_LENGTH = PRELUDE_LENGTH + CHECKSUM_LENGTH * 2;
function splitMessage({ byteLength, byteOffset, buffer }) {
    if (byteLength < MINIMUM_MESSAGE_LENGTH) {
        throw new Error("Provided message too short to accommodate event stream message overhead");
    }
    const view = new DataView(buffer, byteOffset, byteLength);
    const messageLength = view.getUint32(0, false);
    if (byteLength !== messageLength) {
        throw new Error("Reported message length does not match received message length");
    }
    const headerLength = view.getUint32(PRELUDE_MEMBER_LENGTH, false);
    const expectedPreludeChecksum = view.getUint32(PRELUDE_LENGTH, false);
    const expectedMessageChecksum = view.getUint32(byteLength - CHECKSUM_LENGTH, false);
    const checksummer = new Crc32().update(new Uint8Array(buffer, byteOffset, PRELUDE_LENGTH));
    if (expectedPreludeChecksum !== checksummer.digest()) {
        throw new Error(`The prelude checksum specified in the message (${expectedPreludeChecksum}) does not match the calculated CRC32 checksum (${checksummer.digest()})`);
    }
    checksummer.update(new Uint8Array(buffer, byteOffset + PRELUDE_LENGTH, byteLength - (PRELUDE_LENGTH + CHECKSUM_LENGTH)));
    if (expectedMessageChecksum !== checksummer.digest()) {
        throw new Error(`The message checksum (${checksummer.digest()}) did not match the expected value of ${expectedMessageChecksum}`);
    }
    return {
        headers: new DataView(buffer, byteOffset + PRELUDE_LENGTH + CHECKSUM_LENGTH, headerLength),
        body: new Uint8Array(buffer, byteOffset + PRELUDE_LENGTH + CHECKSUM_LENGTH + headerLength, messageLength - headerLength - (PRELUDE_LENGTH + CHECKSUM_LENGTH + CHECKSUM_LENGTH)),
    };
}

class EventStreamCodec {
    constructor(toUtf8, fromUtf8) {
        this.headerMarshaller = new HeaderMarshaller(toUtf8, fromUtf8);
        this.messageBuffer = [];
        this.isEndOfStream = false;
    }
    feed(message) {
        this.messageBuffer.push(this.decode(message));
    }
    endOfStream() {
        this.isEndOfStream = true;
    }
    getMessage() {
        const message = this.messageBuffer.pop();
        const isEndOfStream = this.isEndOfStream;
        return {
            getMessage() {
                return message;
            },
            isEndOfStream() {
                return isEndOfStream;
            },
        };
    }
    getAvailableMessages() {
        const messages = this.messageBuffer;
        this.messageBuffer = [];
        const isEndOfStream = this.isEndOfStream;
        return {
            getMessages() {
                return messages;
            },
            isEndOfStream() {
                return isEndOfStream;
            },
        };
    }
    encode({ headers: rawHeaders, body }) {
        const headers = this.headerMarshaller.format(rawHeaders);
        const length = headers.byteLength + body.byteLength + 16;
        const out = new Uint8Array(length);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        const checksum = new Crc32();
        view.setUint32(0, length, false);
        view.setUint32(4, headers.byteLength, false);
        view.setUint32(8, checksum.update(out.subarray(0, 8)).digest(), false);
        out.set(headers, 12);
        out.set(body, headers.byteLength + 12);
        view.setUint32(length - 4, checksum.update(out.subarray(8, length - 4)).digest(), false);
        return out;
    }
    decode(message) {
        const { headers, body } = splitMessage(message);
        return { headers: this.headerMarshaller.parse(headers), body };
    }
    formatHeaders(rawHeaders) {
        return this.headerMarshaller.format(rawHeaders);
    }
}

class MessageDecoderStream {
    constructor(options) {
        this.options = options;
    }
    [Symbol.asyncIterator]() {
        return this.asyncIterator();
    }
    async *asyncIterator() {
        for await (const bytes of this.options.inputStream) {
            const decoded = this.options.decoder.decode(bytes);
            yield decoded;
        }
    }
}

class MessageEncoderStream {
    constructor(options) {
        this.options = options;
    }
    [Symbol.asyncIterator]() {
        return this.asyncIterator();
    }
    async *asyncIterator() {
        for await (const msg of this.options.messageStream) {
            const encoded = this.options.encoder.encode(msg);
            yield encoded;
        }
        if (this.options.includeEndFrame) {
            yield new Uint8Array(0);
        }
    }
}

class SmithyMessageDecoderStream {
    constructor(options) {
        this.options = options;
    }
    [Symbol.asyncIterator]() {
        return this.asyncIterator();
    }
    async *asyncIterator() {
        for await (const message of this.options.messageStream) {
            const deserialized = await this.options.deserializer(message);
            if (deserialized === undefined)
                continue;
            yield deserialized;
        }
    }
}

class SmithyMessageEncoderStream {
    constructor(options) {
        this.options = options;
    }
    [Symbol.asyncIterator]() {
        return this.asyncIterator();
    }
    async *asyncIterator() {
        for await (const chunk of this.options.inputStream) {
            const payloadBuf = this.options.serializer(chunk);
            yield payloadBuf;
        }
    }
}

function getChunkedStream(source) {
    let currentMessageTotalLength = 0;
    let currentMessagePendingLength = 0;
    let currentMessage = null;
    let messageLengthBuffer = null;
    const allocateMessage = (size) => {
        if (typeof size !== "number") {
            throw new Error("Attempted to allocate an event message where size was not a number: " + size);
        }
        currentMessageTotalLength = size;
        currentMessagePendingLength = 4;
        currentMessage = new Uint8Array(size);
        const currentMessageView = new DataView(currentMessage.buffer);
        currentMessageView.setUint32(0, size, false);
    };
    const iterator = async function* () {
        const sourceIterator = source[Symbol.asyncIterator]();
        while (true) {
            const { value, done } = await sourceIterator.next();
            if (done) {
                if (!currentMessageTotalLength) {
                    return;
                }
                else if (currentMessageTotalLength === currentMessagePendingLength) {
                    yield currentMessage;
                }
                else {
                    throw new Error("Truncated event message received.");
                }
                return;
            }
            const chunkLength = value.length;
            let currentOffset = 0;
            while (currentOffset < chunkLength) {
                if (!currentMessage) {
                    const bytesRemaining = chunkLength - currentOffset;
                    if (!messageLengthBuffer) {
                        messageLengthBuffer = new Uint8Array(4);
                    }
                    const numBytesForTotal = Math.min(4 - currentMessagePendingLength, bytesRemaining);
                    messageLengthBuffer.set(value.slice(currentOffset, currentOffset + numBytesForTotal), currentMessagePendingLength);
                    currentMessagePendingLength += numBytesForTotal;
                    currentOffset += numBytesForTotal;
                    if (currentMessagePendingLength < 4) {
                        break;
                    }
                    allocateMessage(new DataView(messageLengthBuffer.buffer).getUint32(0, false));
                    messageLengthBuffer = null;
                }
                const numBytesToWrite = Math.min(currentMessageTotalLength - currentMessagePendingLength, chunkLength - currentOffset);
                currentMessage.set(value.slice(currentOffset, currentOffset + numBytesToWrite), currentMessagePendingLength);
                currentMessagePendingLength += numBytesToWrite;
                currentOffset += numBytesToWrite;
                if (currentMessageTotalLength && currentMessageTotalLength === currentMessagePendingLength) {
                    yield currentMessage;
                    currentMessage = null;
                    currentMessageTotalLength = 0;
                    currentMessagePendingLength = 0;
                }
            }
        }
    };
    return {
        [Symbol.asyncIterator]: iterator,
    };
}

function getMessageUnmarshaller(deserializer, toUtf8) {
    return async function (message) {
        const { value: messageType } = message.headers[":message-type"];
        if (messageType === "error") {
            const unmodeledError = new Error(message.headers[":error-message"].value || "UnknownError");
            unmodeledError.name = message.headers[":error-code"].value;
            throw unmodeledError;
        }
        else if (messageType === "exception") {
            const code = message.headers[":exception-type"].value;
            const exception = { [code]: message };
            const deserializedException = await deserializer(exception);
            if (deserializedException.$unknown) {
                const error = new Error(toUtf8(message.body));
                error.name = code;
                throw error;
            }
            throw deserializedException[code];
        }
        else if (messageType === "event") {
            const event = {
                [message.headers[":event-type"].value]: message,
            };
            const deserialized = await deserializer(event);
            if (deserialized.$unknown)
                return;
            return deserialized;
        }
        else {
            throw Error(`Unrecognizable event type: ${message.headers[":event-type"].value}`);
        }
    };
}

class EventStreamMarshaller$1 {
    constructor({ utf8Encoder, utf8Decoder }) {
        this.eventStreamCodec = new EventStreamCodec(utf8Encoder, utf8Decoder);
        this.utfEncoder = utf8Encoder;
    }
    deserialize(body, deserializer) {
        const inputStream = getChunkedStream(body);
        return new SmithyMessageDecoderStream({
            messageStream: new MessageDecoderStream({ inputStream, decoder: this.eventStreamCodec }),
            deserializer: getMessageUnmarshaller(deserializer, this.utfEncoder),
        });
    }
    serialize(inputStream, serializer) {
        return new MessageEncoderStream({
            messageStream: new SmithyMessageEncoderStream({ inputStream, serializer }),
            encoder: this.eventStreamCodec,
            includeEndFrame: true,
        });
    }
}

async function* readabletoIterable(readStream) {
    let streamEnded = false;
    let generationEnded = false;
    const records = new Array();
    readStream.on("error", (err) => {
        if (!streamEnded) {
            streamEnded = true;
        }
        if (err) {
            throw err;
        }
    });
    readStream.on("data", (data) => {
        records.push(data);
    });
    readStream.on("end", () => {
        streamEnded = true;
    });
    while (!generationEnded) {
        const value = await new Promise((resolve) => setTimeout(() => resolve(records.shift()), 0));
        if (value) {
            yield value;
        }
        generationEnded = streamEnded && records.length === 0;
    }
}

class EventStreamMarshaller {
    constructor({ utf8Encoder, utf8Decoder }) {
        this.universalMarshaller = new EventStreamMarshaller$1({
            utf8Decoder,
            utf8Encoder,
        });
    }
    deserialize(body, deserializer) {
        const bodyIterable = typeof body[Symbol.asyncIterator] === "function" ? body : readabletoIterable(body);
        return this.universalMarshaller.deserialize(bodyIterable, deserializer);
    }
    serialize(input, serializer) {
        return Readable.from(this.universalMarshaller.serialize(input, serializer));
    }
}

const eventStreamSerdeProvider = (options) => new EventStreamMarshaller(options);

class Hash {
    constructor(algorithmIdentifier, secret) {
        this.algorithmIdentifier = algorithmIdentifier;
        this.secret = secret;
        this.reset();
    }
    update(toHash, encoding) {
        this.hash.update(toUint8Array(castSourceData(toHash, encoding)));
    }
    digest() {
        return Promise.resolve(this.hash.digest());
    }
    reset() {
        this.hash = this.secret
            ? createHmac(this.algorithmIdentifier, castSourceData(this.secret))
            : createHash(this.algorithmIdentifier);
    }
}
function castSourceData(toCast, encoding) {
    if (Buffer$1.isBuffer(toCast)) {
        return toCast;
    }
    if (typeof toCast === "string") {
        return fromString$1(toCast, encoding);
    }
    if (ArrayBuffer.isView(toCast)) {
        return fromArrayBuffer(toCast.buffer, toCast.byteOffset, toCast.byteLength);
    }
    return fromArrayBuffer(toCast);
}

class HashCalculator extends Writable {
    constructor(hash, options) {
        super(options);
        this.hash = hash;
    }
    _write(chunk, encoding, callback) {
        try {
            this.hash.update(toUint8Array(chunk));
        }
        catch (err) {
            return callback(err);
        }
        callback();
    }
}

const readableStreamHasher = (hashCtor, readableStream) => {
    if (readableStream.readableFlowing !== null) {
        throw new Error("Unable to calculate hash for flowing readable stream");
    }
    const hash = new hashCtor();
    const hashCalculator = new HashCalculator(hash);
    readableStream.pipe(hashCalculator);
    return new Promise((resolve, reject) => {
        readableStream.on("error", (err) => {
            hashCalculator.end();
            reject(err);
        });
        hashCalculator.on("error", reject);
        hashCalculator.on("finish", () => {
            hash.digest().then(resolve).catch(reject);
        });
    });
};

const calculateBodyLength = (body) => {
    if (!body) {
        return 0;
    }
    if (typeof body === "string") {
        return Buffer.byteLength(body);
    }
    else if (typeof body.byteLength === "number") {
        return body.byteLength;
    }
    else if (typeof body.size === "number") {
        return body.size;
    }
    else if (typeof body.start === "number" && typeof body.end === "number") {
        return body.end + 1 - body.start;
    }
    else if (typeof body.path === "string" || Buffer.isBuffer(body.path)) {
        return lstatSync(body.path).size;
    }
    else if (typeof body.fd === "number") {
        return fstatSync(body.fd).size;
    }
    throw new Error(`Body Length computation failed for ${body}`);
};

const getRuntimeConfig$1 = (config) => {
    return {
        apiVersion: "2006-03-01",
        base64Decoder: config?.base64Decoder ?? fromBase64,
        base64Encoder: config?.base64Encoder ?? toBase64,
        disableHostPrefix: config?.disableHostPrefix ?? false,
        endpointProvider: config?.endpointProvider ?? defaultEndpointResolver,
        extensions: config?.extensions ?? [],
        getAwsChunkedEncodingStream: config?.getAwsChunkedEncodingStream ?? getAwsChunkedEncodingStream,
        httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? defaultS3HttpAuthSchemeProvider,
        httpAuthSchemes: config?.httpAuthSchemes ?? [
            {
                schemeId: "aws.auth#sigv4",
                identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4"),
                signer: new AwsSdkSigV4Signer(),
            },
            {
                schemeId: "aws.auth#sigv4a",
                identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4a"),
                signer: new AwsSdkSigV4ASigner(),
            },
        ],
        logger: config?.logger ?? new NoOpLogger(),
        sdkStreamMixin: config?.sdkStreamMixin ?? sdkStreamMixin,
        serviceId: config?.serviceId ?? "S3",
        signerConstructor: config?.signerConstructor ?? SignatureV4MultiRegion,
        signingEscapePath: config?.signingEscapePath ?? false,
        urlParser: config?.urlParser ?? parseUrl,
        useArnRegion: config?.useArnRegion ?? false,
        utf8Decoder: config?.utf8Decoder ?? fromUtf8$2,
        utf8Encoder: config?.utf8Encoder ?? toUtf8,
    };
};

const AWS_EXECUTION_ENV = "AWS_EXECUTION_ENV";
const AWS_REGION_ENV = "AWS_REGION";
const AWS_DEFAULT_REGION_ENV = "AWS_DEFAULT_REGION";
const ENV_IMDS_DISABLED = "AWS_EC2_METADATA_DISABLED";
const DEFAULTS_MODE_OPTIONS = ["in-region", "cross-region", "mobile", "standard", "legacy"];
const IMDS_REGION_PATH = "/latest/meta-data/placement/region";

const AWS_DEFAULTS_MODE_ENV = "AWS_DEFAULTS_MODE";
const AWS_DEFAULTS_MODE_CONFIG = "defaults_mode";
const NODE_DEFAULTS_MODE_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => {
        return env[AWS_DEFAULTS_MODE_ENV];
    },
    configFileSelector: (profile) => {
        return profile[AWS_DEFAULTS_MODE_CONFIG];
    },
    default: "legacy",
};

const resolveDefaultsModeConfig = ({ region = loadConfig(NODE_REGION_CONFIG_OPTIONS), defaultsMode = loadConfig(NODE_DEFAULTS_MODE_CONFIG_OPTIONS), } = {}) => memoize(async () => {
    const mode = typeof defaultsMode === "function" ? await defaultsMode() : defaultsMode;
    switch (mode?.toLowerCase()) {
        case "auto":
            return resolveNodeDefaultsModeAuto(region);
        case "in-region":
        case "cross-region":
        case "mobile":
        case "standard":
        case "legacy":
            return Promise.resolve(mode?.toLocaleLowerCase());
        case undefined:
            return Promise.resolve("legacy");
        default:
            throw new Error(`Invalid parameter for "defaultsMode", expect ${DEFAULTS_MODE_OPTIONS.join(", ")}, got ${mode}`);
    }
});
const resolveNodeDefaultsModeAuto = async (clientRegion) => {
    if (clientRegion) {
        const resolvedRegion = typeof clientRegion === "function" ? await clientRegion() : clientRegion;
        const inferredRegion = await inferPhysicalRegion();
        if (!inferredRegion) {
            return "standard";
        }
        if (resolvedRegion === inferredRegion) {
            return "in-region";
        }
        else {
            return "cross-region";
        }
    }
    return "standard";
};
const inferPhysicalRegion = async () => {
    if (process.env[AWS_EXECUTION_ENV] && (process.env[AWS_REGION_ENV] || process.env[AWS_DEFAULT_REGION_ENV])) {
        return process.env[AWS_REGION_ENV] ?? process.env[AWS_DEFAULT_REGION_ENV];
    }
    if (!process.env[ENV_IMDS_DISABLED]) {
        try {
            const { getInstanceMetadataEndpoint, httpRequest } = await import('./index5.mjs');
            const endpoint = await getInstanceMetadataEndpoint();
            return (await httpRequest({ ...endpoint, path: IMDS_REGION_PATH })).toString();
        }
        catch (e) {
        }
    }
};

const getRuntimeConfig = (config) => {
    emitWarningIfUnsupportedVersion(process.version);
    const defaultsMode = resolveDefaultsModeConfig(config);
    const defaultConfigProvider = () => defaultsMode().then(loadConfigsForDefaultMode);
    const clientSharedValues = getRuntimeConfig$1(config);
    emitWarningIfUnsupportedVersion$1(process.version);
    const profileConfig = { profile: config?.profile };
    return {
        ...clientSharedValues,
        ...config,
        runtime: "node",
        defaultsMode,
        bodyLengthChecker: config?.bodyLengthChecker ?? calculateBodyLength,
        credentialDefaultProvider: config?.credentialDefaultProvider ?? defaultProvider,
        defaultUserAgentProvider: config?.defaultUserAgentProvider ??
            createDefaultUserAgentProvider({ serviceId: clientSharedValues.serviceId, clientVersion: packageInfo.version }),
        disableS3ExpressSessionAuth: config?.disableS3ExpressSessionAuth ??
            loadConfig(NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS, profileConfig),
        eventStreamSerdeProvider: config?.eventStreamSerdeProvider ?? eventStreamSerdeProvider,
        maxAttempts: config?.maxAttempts ?? loadConfig(NODE_MAX_ATTEMPT_CONFIG_OPTIONS, config),
        md5: config?.md5 ?? Hash.bind(null, "md5"),
        region: config?.region ??
            loadConfig(NODE_REGION_CONFIG_OPTIONS, { ...NODE_REGION_CONFIG_FILE_OPTIONS, ...profileConfig }),
        requestChecksumCalculation: config?.requestChecksumCalculation ??
            loadConfig(NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS, profileConfig),
        requestHandler: NodeHttpHandler.create(config?.requestHandler ?? defaultConfigProvider),
        responseChecksumValidation: config?.responseChecksumValidation ??
            loadConfig(NODE_RESPONSE_CHECKSUM_VALIDATION_CONFIG_OPTIONS, profileConfig),
        retryMode: config?.retryMode ??
            loadConfig({
                ...NODE_RETRY_MODE_CONFIG_OPTIONS,
                default: async () => (await defaultConfigProvider()).retryMode || DEFAULT_RETRY_MODE,
            }, config),
        sha1: config?.sha1 ?? Hash.bind(null, "sha1"),
        sha256: config?.sha256 ?? Hash.bind(null, "sha256"),
        sigv4aSigningRegionSet: config?.sigv4aSigningRegionSet ?? loadConfig(NODE_SIGV4A_CONFIG_OPTIONS, profileConfig),
        streamCollector: config?.streamCollector ?? streamCollector$1,
        streamHasher: config?.streamHasher ?? readableStreamHasher,
        useArnRegion: config?.useArnRegion ?? loadConfig(NODE_USE_ARN_REGION_CONFIG_OPTIONS, profileConfig),
        useDualstackEndpoint: config?.useDualstackEndpoint ?? loadConfig(NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS, profileConfig),
        useFipsEndpoint: config?.useFipsEndpoint ?? loadConfig(NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, profileConfig),
        userAgentAppId: config?.userAgentAppId ?? loadConfig(NODE_APP_ID_CONFIG_OPTIONS, profileConfig),
    };
};

const getAwsRegionExtensionConfiguration = (runtimeConfig) => {
    let runtimeConfigRegion = async () => {
        if (runtimeConfig.region === undefined) {
            throw new Error("Region is missing from runtimeConfig");
        }
        const region = runtimeConfig.region;
        if (typeof region === "string") {
            return region;
        }
        return region();
    };
    return {
        setRegion(region) {
            runtimeConfigRegion = region;
        },
        region() {
            return runtimeConfigRegion;
        },
    };
};
const resolveAwsRegionExtensionConfiguration = (awsRegionExtensionConfiguration) => {
    return {
        region: awsRegionExtensionConfiguration.region(),
    };
};

const getHttpAuthExtensionConfiguration = (runtimeConfig) => {
    const _httpAuthSchemes = runtimeConfig.httpAuthSchemes;
    let _httpAuthSchemeProvider = runtimeConfig.httpAuthSchemeProvider;
    let _credentials = runtimeConfig.credentials;
    return {
        setHttpAuthScheme(httpAuthScheme) {
            const index = _httpAuthSchemes.findIndex((scheme) => scheme.schemeId === httpAuthScheme.schemeId);
            if (index === -1) {
                _httpAuthSchemes.push(httpAuthScheme);
            }
            else {
                _httpAuthSchemes.splice(index, 1, httpAuthScheme);
            }
        },
        httpAuthSchemes() {
            return _httpAuthSchemes;
        },
        setHttpAuthSchemeProvider(httpAuthSchemeProvider) {
            _httpAuthSchemeProvider = httpAuthSchemeProvider;
        },
        httpAuthSchemeProvider() {
            return _httpAuthSchemeProvider;
        },
        setCredentials(credentials) {
            _credentials = credentials;
        },
        credentials() {
            return _credentials;
        },
    };
};
const resolveHttpAuthRuntimeConfig = (config) => {
    return {
        httpAuthSchemes: config.httpAuthSchemes(),
        httpAuthSchemeProvider: config.httpAuthSchemeProvider(),
        credentials: config.credentials(),
    };
};

const asPartial = (t) => t;
const resolveRuntimeExtensions = (runtimeConfig, extensions) => {
    const extensionConfiguration = {
        ...asPartial(getAwsRegionExtensionConfiguration(runtimeConfig)),
        ...asPartial(getDefaultExtensionConfiguration(runtimeConfig)),
        ...asPartial(getHttpHandlerExtensionConfiguration(runtimeConfig)),
        ...asPartial(getHttpAuthExtensionConfiguration(runtimeConfig)),
    };
    extensions.forEach((extension) => extension.configure(extensionConfiguration));
    return {
        ...runtimeConfig,
        ...resolveAwsRegionExtensionConfiguration(extensionConfiguration),
        ...resolveDefaultRuntimeConfig(extensionConfiguration),
        ...resolveHttpHandlerRuntimeConfig(extensionConfiguration),
        ...resolveHttpAuthRuntimeConfig(extensionConfiguration),
    };
};

class S3Client extends Client {
    config;
    constructor(...[configuration]) {
        const _config_0 = getRuntimeConfig(configuration || {});
        const _config_1 = resolveClientEndpointParameters(_config_0);
        const _config_2 = resolveUserAgentConfig(_config_1);
        const _config_3 = resolveFlexibleChecksumsConfig(_config_2);
        const _config_4 = resolveRetryConfig(_config_3);
        const _config_5 = resolveRegionConfig(_config_4);
        const _config_6 = resolveHostHeaderConfig(_config_5);
        const _config_7 = resolveEndpointConfig(_config_6);
        const _config_8 = resolveEventStreamSerdeConfig(_config_7);
        const _config_9 = resolveHttpAuthSchemeConfig(_config_8);
        const _config_10 = resolveS3Config(_config_9, { session: [() => this, CreateSessionCommand] });
        const _config_11 = resolveRuntimeExtensions(_config_10, configuration?.extensions || []);
        super(_config_11);
        this.config = _config_11;
        this.middlewareStack.use(getUserAgentPlugin(this.config));
        this.middlewareStack.use(getRetryPlugin(this.config));
        this.middlewareStack.use(getContentLengthPlugin(this.config));
        this.middlewareStack.use(getHostHeaderPlugin(this.config));
        this.middlewareStack.use(getLoggerPlugin(this.config));
        this.middlewareStack.use(getRecursionDetectionPlugin(this.config));
        this.middlewareStack.use(getHttpAuthSchemeEndpointRuleSetPlugin(this.config, {
            httpAuthSchemeParametersProvider: defaultS3HttpAuthSchemeParametersProvider,
            identityProviderConfigProvider: async (config) => new DefaultIdentityProviderConfig({
                "aws.auth#sigv4": config.credentials,
                "aws.auth#sigv4a": config.credentials,
            }),
        }));
        this.middlewareStack.use(getHttpSigningPlugin(this.config));
        this.middlewareStack.use(getValidateBucketNamePlugin(this.config));
        this.middlewareStack.use(getAddExpectContinuePlugin(this.config));
        this.middlewareStack.use(getRegionRedirectMiddlewarePlugin(this.config));
        this.middlewareStack.use(getS3ExpressPlugin(this.config));
        this.middlewareStack.use(getS3ExpressHttpSigningPlugin(this.config));
    }
    destroy() {
        super.destroy();
    }
}

function ssecMiddleware(options) {
    return (next) => async (args) => {
        const input = { ...args.input };
        const properties = [
            {
                target: "SSECustomerKey",
                hash: "SSECustomerKeyMD5",
            },
            {
                target: "CopySourceSSECustomerKey",
                hash: "CopySourceSSECustomerKeyMD5",
            },
        ];
        for (const prop of properties) {
            const value = input[prop.target];
            if (value) {
                let valueForHash;
                if (typeof value === "string") {
                    if (isValidBase64EncodedSSECustomerKey(value, options)) {
                        valueForHash = options.base64Decoder(value);
                    }
                    else {
                        valueForHash = options.utf8Decoder(value);
                        input[prop.target] = options.base64Encoder(valueForHash);
                    }
                }
                else {
                    valueForHash = ArrayBuffer.isView(value)
                        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                        : new Uint8Array(value);
                    input[prop.target] = options.base64Encoder(valueForHash);
                }
                const hash = new options.md5();
                hash.update(valueForHash);
                input[prop.hash] = options.base64Encoder(await hash.digest());
            }
        }
        return next({
            ...args,
            input,
        });
    };
}
const ssecMiddlewareOptions = {
    name: "ssecMiddleware",
    step: "initialize",
    tags: ["SSE"],
    override: true,
};
const getSsecPlugin = (config) => ({
    applyToStack: (clientStack) => {
        clientStack.add(ssecMiddleware(config), ssecMiddlewareOptions);
    },
});
function isValidBase64EncodedSSECustomerKey(str, options) {
    const base64Regex = /^(?:[A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    if (!base64Regex.test(str))
        return false;
    try {
        const decodedBytes = options.base64Decoder(str);
        return decodedBytes.length === 32;
    }
    catch {
        return false;
    }
}

class GetObjectCommand extends Command
    .classBuilder()
    .ep({
    ...commonParams,
    Bucket: { type: "contextParams", name: "Bucket" },
    Key: { type: "contextParams", name: "Key" },
})
    .m(function (Command, cs, config, o) {
    return [
        getSerdePlugin(config, this.serialize, this.deserialize),
        getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
        getFlexibleChecksumsPlugin(config, {
            requestChecksumRequired: false,
            requestValidationModeMember: "ChecksumMode",
            responseAlgorithms: ["CRC64NVME", "CRC32", "CRC32C", "SHA256", "SHA1"],
        }),
        getSsecPlugin(config),
        getS3ExpiresMiddlewarePlugin(),
    ];
})
    .s("AmazonS3", "GetObject", {})
    .n("S3Client", "GetObjectCommand")
    .f(GetObjectRequestFilterSensitiveLog, GetObjectOutputFilterSensitiveLog)
    .ser(se_GetObjectCommand)
    .de(de_GetObjectCommand)
    .build() {
}

class HeadObjectCommand extends Command
    .classBuilder()
    .ep({
    ...commonParams,
    Bucket: { type: "contextParams", name: "Bucket" },
    Key: { type: "contextParams", name: "Key" },
})
    .m(function (Command, cs, config, o) {
    return [
        getSerdePlugin(config, this.serialize, this.deserialize),
        getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
        getThrow200ExceptionsPlugin(config),
        getSsecPlugin(config),
        getS3ExpiresMiddlewarePlugin(),
    ];
})
    .s("AmazonS3", "HeadObject", {})
    .n("S3Client", "HeadObjectCommand")
    .f(HeadObjectRequestFilterSensitiveLog, HeadObjectOutputFilterSensitiveLog)
    .ser(se_HeadObjectCommand)
    .de(de_HeadObjectCommand)
    .build() {
}

// S3Store.ts
// A very minimal custom S3 store example. 
// This store is read-only; 'setItem' or 'deleteItem' either throw 
// or remain unimplemented.
//
// Usage: const store = new S3Store('my-bucket', 'my-zarr-prefix/');
// Then pass `store` to openArray({ store, path: '', mode: 'r' }) (or with a sub-path).
class S3Store {
    constructor(bucketName, prefix, cacheLimit = 3, options) {
        this.bucketName = bucketName;
        this.prefix = prefix;
        this.cacheLimit = cacheLimit;
        // TODO Doesnt this fuck up storage - caching locally
        this.cache = new Map();
        this.cacheStack = [];
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.cacheReplaces = 0;
        this.s3 = new S3Client(options !== null && options !== void 0 ? options : []);
    }
    /**
     * Get an item (chunk or metadata) from S3.
     * @param key The Zarr key (e.g. "0.0", ".zarray", etc.)
     */
    async getItem(key, opts) {
        const objectKey = `${this.prefix}/${key}`;
        if (objectKey.split("/").pop().charAt(0) == '.') {
            // .zarray, .zmetadata etc.
            // cached automatically within zarr.js so no need to cache here
            const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: objectKey }));
            if (!response.Body)
                throw new Error(`Object body not found at ${this.bucketName}/${objectKey}`);
            return response.Body.transformToString();
        }
        // Array chunk file
        // Return from cache if present:
        if (this.cache.has(objectKey)) {
            this.cacheHits++;
            return this.cache.get(objectKey);
        }
        this.cacheMisses++;
        // Fetch from S3:
        const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: objectKey }));
        if (!response.Body) {
            throw new Error(`Object body not found at ${this.bucketName}/${objectKey}`);
        }
        // Convert Body to ArrayBuffer:
        // console.time('timer');
        const arrayBuffer = await this.streamToArrayBuffer(response.Body);
        // console.timeEnd('timer');
        if (this.cacheStack.length >= this.cacheLimit) {
            this.cacheReplaces++;
            const keyToDelete = this.cacheStack.shift();
            this.cache.delete(keyToDelete);
        }
        this.cache.set(objectKey, arrayBuffer);
        this.cacheStack.push(objectKey);
        return arrayBuffer;
    }
    /**
     * Set an item in S3 (not implemented in this example).
     */
    async setItem(key, value) {
        throw new Error("S3Store setItem not implemented in this read-only example.");
    }
    /**
     * Delete an item in S3 (not implemented).
     */
    async deleteItem(key) {
        throw new Error("S3Store deleteItem not implemented in this read-only example.");
    }
    /**
     * Check if an item exists in S3.
     */
    async containsItem(key) {
        const objectKey = `${this.prefix}/${key}`;
        try {
            await this.s3.send(new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: objectKey
            }));
        }
        catch (caught) {
            if (caught instanceof NoSuchKey)
                return false;
        }
        return true;
    }
    /**
     * streamToArrayBuffer helper: convert an AWS SDK v3 response Body stream into an ArrayBuffer.
     * Works in Node.js. If you are in a browser, adapt to a web stream or use a different approach.
     */
    async streamToArrayBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const buffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const c of chunks) {
            buffer.set(c, offset);
            offset += c.length;
        }
        return buffer.buffer;
    }
    /**
     * Optional: list known keys (not used by the default zarr.js reading path).
     * Potentially expensive for large datasets. Not implemented here.
     */
    async keys() {
        throw new Error("S3Store keys() not implemented.");
    }
    /**
     * Clean up if needed. Here, nothing to do.
     */
    async close() {
        this.s3.destroy();
        console.log(`Closing Store: cache had ${this.cacheHits} hits, ${this.cacheMisses} misses and ${this.cacheReplaces} replacements`);
    }
}

export { ArrayNotFoundError, AwsSdkSigV4Signer, BoundsCheckError, Client, Command, ContainsArrayError, ContainsGroupError, CredentialsProviderError, DEFAULT_RETRY_MODE, DefaultIdentityProviderConfig, EndpointCache, Group, GroupNotFoundError, HTTPError, HTTPStore, Hash, HttpRequest, InvalidSliceError, KeyError, MemoryStore, NODE_APP_ID_CONFIG_OPTIONS, NODE_MAX_ATTEMPT_CONFIG_OPTIONS, NODE_REGION_CONFIG_FILE_OPTIONS, NODE_REGION_CONFIG_OPTIONS, NODE_RETRY_MODE_CONFIG_OPTIONS, NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS, NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, NegativeStepError, NestedArray, NoAuthSigner, NoOpLogger, NodeHttpHandler, ObjectStore, PathNotFoundError, PermissionError, ProviderError, S3Store, SENSITIVE_STRING, ServiceException, TokenProviderError, TooManyIndicesError, ValueError, ZarrArray, _json, addCodec, array, awsEndpointFunctions, calculateBodyLength, chain, create, createAggregatedClient, createDefaultUserAgentProvider, createProxy, customEndpointFunctions, decorateServiceException, emitWarningIfUnsupportedVersion, emitWarningIfUnsupportedVersion$1, empty, expectInt32, expectNonNull, expectObject, expectString, extendedEncodeURIComponent, fromBase64, fromUtf8$2 as fromUtf8, full, getAwsRegionExtensionConfiguration, getCodec, getContentLengthPlugin, getDefaultExtensionConfiguration, getEndpointPlugin, getHostHeaderPlugin, getHttpAuthSchemeEndpointRuleSetPlugin, getHttpHandlerExtensionConfiguration, getHttpSigningPlugin, getLoggerPlugin, getProfileName, getRecursionDetectionPlugin, getRetryPlugin, getSSOTokenFilepath, getSSOTokenFromFile, getSerdePlugin, getSmithyContext, getTypedArrayCtr, getTypedArrayDtypeString, getUserAgentPlugin, group, index, isKeyError, isSerializableHeaderValue, loadConfig, loadConfigsForDefaultMode, loadRestJsonErrorCode, loadSsoSessionData, map, normalizeProvider$1 as normalizeProvider, normalizeStoreArgument, ones, openArray, openGroup, parseJsonBody, parseJsonErrorBody, parseKnownFiles, parseRfc3339DateTime, parseRfc3339DateTimeWithOffset, parseUrl, parseXmlBody, parseXmlErrorBody, rangeTypedArray, requestBuilder, resolveAwsRegionExtensionConfiguration, resolveAwsSdkSigV4Config, resolveDefaultRuntimeConfig, resolveDefaultsModeConfig, resolveEndpoint, resolveEndpointConfig, resolveHostHeaderConfig, resolveHttpHandlerRuntimeConfig, resolveRegionConfig, resolveRetryConfig, resolveUserAgentConfig, sdkStreamMixin, setCredentialFeature, slice, sliceIndices, streamCollector$1 as streamCollector, strictParseInt32, take, toBase64, toUtf8, withBaseException, zeros };
//# sourceMappingURL=core.mjs.map
