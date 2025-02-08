import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import { terser } from 'rollup-plugin-terser';
import visualizer from 'rollup-plugin-visualizer';
import json from '@rollup/plugin-json';

const commonPlugins = () => [typescript({ useTsconfigDeclarationDir: true }), commonjs(), resolve(), json()];

export default [
  {
    input: 'src/zarr.ts',
    output: [{
      dir: 'dist/',
      format: 'es',
      entryFileNames: '[name].mjs',
      chunkFileNames: '[name].mjs',
      manualChunks: { core: ['src/zarr-core.ts'] },
      minifyInternalExports: false,
      sourcemap: true,
    },
    {
      dir: 'dist/',
      format: 'es',
      entryFileNames: '[name].min.mjs',
      chunkFileNames: '[name].min.mjs',
      manualChunks: { core: ['src/zarr-core.ts'] },
      minifyInternalExports: false,
      sourcemap: true,
      plugins: [terser()]
    },
    ],
    watch: {
      include: 'src/**',
    },
    plugins: [
      ...commonPlugins(),
      visualizer({ filename: "stats.html" }),
      visualizer({ filename: "stats.min.html", sourcemap: true })
    ],
  },
  {
    input: 'src/zarr.ts',
    output: [
      { dir: 'dist/', format: 'cjs', entryFileNames: 'zarr.cjs', sourcemap: true },
      // {
      //   dir: 'dist/',
      //   entryFileNames: 'zarr.umd.js',
      //   name: 'zarr',
      //   format: 'umd',
      //   sourcemap: true,
      //   esModule: false,
      //   plugins: [terser()],
      // },
    ],
    plugins: [
      ...commonPlugins()
    ],
  },
];
