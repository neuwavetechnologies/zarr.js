// S3Store.ts

import { AsyncStore } from "./types";
import { GetObjectCommand, HeadObjectCommand, NoSuchKey, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";

// A very minimal custom S3 store example. 
// This store is read-only; 'setItem' or 'deleteItem' either throw 
// or remain unimplemented.
//
// Usage: const store = new S3Store('my-bucket', 'my-zarr-prefix/');
// Then pass `store` to openArray({ store, path: '', mode: 'r' }) (or with a sub-path).

export class S3Store implements AsyncStore<ArrayBuffer, any> {
  private s3: S3Client;

  // TODO Doesnt this fuck up storage - caching locally
  private cache: Map<string, ArrayBuffer> = new Map(); 
  private cacheStack: string[] = [];
  
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheReplaces = 0;

  constructor(private bucketName: string, private prefix: string, private cacheLimit: number = 3, options?: S3ClientConfig) {
    this.s3 = new S3Client(options ?? []);
  }

  /**
   * Get an item (chunk or metadata) from S3.
   * @param key The Zarr key (e.g. "0.0", ".zarray", etc.)
   */
  async getItem(key: string, opts?: { signal?: AbortSignal }): Promise<ArrayBuffer | any> {
    const objectKey = `${this.prefix}/${key}`;

    if (objectKey.split("/").pop()!.charAt(0) == '.'){
      // .zarray, .zmetadata etc.
      // cached automatically within zarr.js so no need to cache here
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: objectKey }));

      if (!response.Body) 
        throw new Error(`Object body not found at ${this.bucketName}/${objectKey}`);

      return response.Body.transformToString()
    }

    // Array chunk file
    // Return from cache if present:
    if (this.cache.has(objectKey)) {
      this.cacheHits++;
      return this.cache.get(objectKey)!;
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
    
    if (this.cacheStack.length >= this.cacheLimit){
      this.cacheReplaces++;
      const keyToDelete = this.cacheStack.shift()!;
      this.cache.delete(keyToDelete);
    }

    this.cache.set(objectKey, arrayBuffer);
    this.cacheStack.push(objectKey);

    return arrayBuffer;
  }

  /**
   * Set an item in S3 (not implemented in this example).
   */
  async setItem(key: string, value: ArrayBuffer): Promise<boolean> {
    throw new Error("S3Store setItem not implemented in this read-only example.");
  }

  /**
   * Delete an item in S3 (not implemented).
   */
  async deleteItem(key: string): Promise<boolean> {
    throw new Error("S3Store deleteItem not implemented in this read-only example.");
  }

  /**
   * Check if an item exists in S3.
   */
  async containsItem(key: string): Promise<boolean> {
    const objectKey = `${this.prefix}/${key}`;
    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: objectKey
        })
      );
    } catch (caught) {
      if (caught instanceof NoSuchKey)
        return false;
    }
    return true;
  }

  /**
   * streamToArrayBuffer helper: convert an AWS SDK v3 response Body stream into an ArrayBuffer.
   * Works in Node.js. If you are in a browser, adapt to a web stream or use a different approach.
   */
  private async streamToArrayBuffer(stream: any): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
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
  async keys(): Promise<string[]> {
    throw new Error("S3Store keys() not implemented.");
  }

  /**
   * Clean up if needed. Here, nothing to do.
   */
  async close(): Promise<void> {
    this.s3.destroy();
    console.log(`Closing Store: cache had ${this.cacheHits} hits, ${this.cacheMisses} misses and ${this.cacheReplaces} replacements`);
  }
}