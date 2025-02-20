import { paraglide } from '@inlang/paraglide-sveltekit/vite';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath, URL } from 'url';

export default defineConfig({
	plugins: [
		sveltekit(),
		paraglide({
			project: './project.inlang',
			outdir: './src/lib/paraglide'
		})
	],

	test: {
		include: ['src/**/*.{test,spec}.{js,ts}']
	},

	resolve: {
		alias: {
			$components: fileURLToPath(new URL('./src/components', import.meta.url)),
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			$routes: fileURLToPath(new URL('./src/routes', import.meta.url))
		}
	}
});
