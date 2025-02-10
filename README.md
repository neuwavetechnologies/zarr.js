# Forked Repository
This is a forked version of [zarr.js]{https://github.com/gzuidhof/zarr.js}, enabling easy S3 connection to zarr datasets using an S3Store and an in-built cache for fast frequent lookups. This version also enables 'reading' Datetime values from zarr files, brute-forced by casting Int64 to Float64 within zarr. For now, accessing the actual values requires some user code to convert back from Float64, such as:
```
function float64ToInt64Bits(value: number): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);  // Alias to same memory
  return Number(view.getBigInt64(0, false));  // Return as bigint
}

async function getIndexFromTime(timeArray: ZarrArray, time0: Date, time: Date): Promise<number> {
  return float64ToInt64Bits((await timeArray.get(getHourDiff(time0, time))) as number);
}
```

Changes include:
* s3store.ts for the S3Store implementation;
* package.json for the aws-sdk dependency;
* rollup.config.ts to fix rollup with json dependency (ln6: import json from '@rollup/plugin-json');
* zarr-core.ts to export S3Store;
* names.ts/types.ts for Int64 'integration';

--------------------------------------------------------

![Zarr.js Logo](docs/logo.png)

[![Actions Status](https://github.com/gzuidhof/zarr.js/actions/workflows/test.yml/badge.svg)](https://github.com/gzuidhof/zarr.js/actions)
![Top Language Badge](https://img.shields.io/github/languages/top/gzuidhof/zarr.js)
[![NPM badge](https://img.shields.io/npm/v/zarr)](https://www.npmjs.com/package/zarr)
[![Documentation](https://img.shields.io/badge/Read%20the-documentation-1abc9c.svg)](http://guido.io/zarr.js)

---
Typescript implementation of [**Zarr**](https://zarr.readthedocs.io/en/stable/).
> Zarr is a library for chunked, compressed, N-dimensional arrays.

## Quick start

```
npm i zarr
```

See the Getting Started section in the [**Documentation**](http://guido.io/zarr.js).

### Type Docs
You can generate the type documentation for this project by running `npm run generate-typedocs`.

## Why a Typescript implementation for Zarr?
For better or for worse the browser environment is slowly becoming the world's operating system. Numerical computing with a lot of data is a poor fit for browsers, but for data visualization, exploration and result-sharing the browser is unparalleled.

With this library a workflow as such becomes possible:
* You run an experiment/workflow in Python or Julia.
* You write results to a Zarr store, perhaps one that lives in some cloud storage.
* In a browser you create a visualization suite which allows for some interactivity.
* You share a link to a colleague or friend.
