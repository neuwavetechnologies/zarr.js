import { AsyncStore } from "./types";
import { S3ClientConfig } from "@aws-sdk/client-s3";
export declare class S3Store implements AsyncStore<ArrayBuffer, any> {
    private bucketName;
    private prefix;
    private cacheLimit;
    private s3;
    private cache;
    private cacheStack;
    private cacheHits;
    private cacheMisses;
    private cacheReplaces;
    constructor(bucketName: string, prefix: string, cacheLimit?: number, options?: S3ClientConfig);
    /**
     * Get an item (chunk or metadata) from S3.
     * @param key The Zarr key (e.g. "0.0", ".zarray", etc.)
     */
    getItem(key: string, opts?: {
        signal?: AbortSignal;
    }): Promise<ArrayBuffer | any>;
    /**
     * Set an item in S3 (not implemented in this example).
     */
    setItem(key: string, value: ArrayBuffer): Promise<boolean>;
    /**
     * Delete an item in S3 (not implemented).
     */
    deleteItem(key: string): Promise<boolean>;
    /**
     * Check if an item exists in S3.
     */
    containsItem(key: string): Promise<boolean>;
    /**
     * streamToArrayBuffer helper: convert an AWS SDK v3 response Body stream into an ArrayBuffer.
     * Works in Node.js. If you are in a browser, adapt to a web stream or use a different approach.
     */
    private streamToArrayBuffer;
    /**
     * Optional: list known keys (not used by the default zarr.js reading path).
     * Potentially expensive for large datasets. Not implemented here.
     */
    keys(): Promise<string[]>;
    /**
     * Clean up if needed. Here, nothing to do.
     */
    close(): Promise<void>;
}
