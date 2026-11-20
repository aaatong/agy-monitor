import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'src/web',
  plugins: [preact(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: '../../sidecars/monitor-ui/web',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
