/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unused-vars */
// S3Store.ts
import { GetObjectCommand, HeadObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
// A very minimal custom S3 store example. 
// This store is read-only; 'setItem' or 'deleteItem' either throw 
// or remain unimplemented.
//
// Usage: const store = new S3Store('my-bucket', 'my-zarr-prefix/');
// Then pass `store` to openArray({ store, path: '', mode: 'r' }) (or with a sub-path).
export class S3Store {
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
//# sourceMappingURL=s3Store.js.map