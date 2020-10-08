import { klona } from 'klona';
import { join, resolve } from 'path';
import * as scoped from '../utils/scoped';
import * as utils from '../utils/index';
import * as log from '../utils/log';
import * as fs from '../utils/fs';
import { defaults } from './options';
import * as Plugin from './plugins';

// modified pwa/core util
export function merge(old: Config.Options, nxt: Partial<Config.Options> | Config.Customize.Options, context: Config.Context) {
	for (let k in nxt) {
		if (k === 'rollup') continue;
		if (typeof nxt[k] === 'function') {
			old[k] = old[k] || {};
			nxt[k](old[k], context);
		} else {
			old[k] = nxt[k] || old[k];
		}
	}
}

export async function load(argv: Argv.Options): Promise<Config.Group> {
	const { cwd, src, isProd } = argv;

	const file = utils.load<TODO>('freshie.config.js', cwd);

	// planning to mutate
	const options = klona(defaults);
	const customize: Config.Customize.Rollup[] = [];
	const context: Config.Context = { isProd, ssr: false }; // TODO: ssr value

	function autoload(name: string) {
		log.info(`Applying ${ log.$pkg(name) } preset`);
		let abs = utils.from(cwd, join(name, 'config.js'));
		let tmp = require(abs); // allow potential throw
		if (tmp.rollup) customize.push(tmp.rollup);
		merge(options, tmp, context);
	}

	// auto-load @freshie packages
	scoped.list(cwd).forEach(autoload);

	if (file) {
		log.info(`Applying "${ log.$dir('freshie.config.js') }" config`);
		if (file.rollup) customize.push(file.rollup);
		merge(options, file, context);
	}

	const aliases = options.alias.entries;

	// update special aliases
	aliases['~assets'] = options.assets.dir;
	aliases['~routes'] = options.routes.dir;

	// resolve aliases
	for (let key in aliases) {
		let tmp = aliases[key];
		aliases[key] = resolve(src, tmp);
	}

	const routes = await utils.routes(argv.src, options.routes);
	if (!routes.length) throw new Error('No routes found!');

	// resolve copy list (from src dir)
	options.copy = options.copy.map(dir => {
		return resolve(src, dir);
	});

	// replacements
	options.replace.__DEV__ = String(!isProd);
	options.replace['process.env.NODE_ENV'] = JSON.stringify(isProd ? 'production' : 'development');

	const client = Client(argv, routes, options, context);

	let server: Nullable<Rollup.Config>;

	// force node for dev
	if (argv.ssr && !isProd) {
		options.ssr.type = 'node';
	} else if (argv.ssr && !options.ssr.type) {
		autoload('@freshie/ssr.node');
	} else if (!argv.ssr) {
		options.ssr.type = null; // --no-ssr
	}

	if (argv.ssr && options.ssr.type) {
		// Apply special SSR aliases
		scoped.list(cwd).forEach(name => {
			if (/[/]ui\./.test(name)) {
				aliases['~!!ui!!~'] = utils.from(cwd, name);
			}
		});

		// Create SSR bundle config
		server = Server(argv, routes, options, context);
	}

	// auto-detect entries; set SSR entry
	await fs.list(src).then(files => {
		let rel = fs.match(files, /index\.(dom\.)?[tjm]sx?/);
		if (rel) client.input = join(src, rel);

		rel = server && fs.match(files, /index\.ssr\.[tjm]sx?/);
		if (server && rel) server.input = join(src, rel);
		else if (server) server.input = options.ssr.entry;
	});

	customize.forEach(mutate => {
		mutate(client, options, context);
		if (server) mutate(server, options, context);
	});

	return { options, client, server };
}

export function Client(argv: Argv.Options, routes: Build.Route[], options: Config.Options, context: Config.Context): Rollup.Config {
	const { src, dest, minify } = argv;
	const { isProd } = context;

	return {
		// NOTE: may inject auto-detect
		input: join(src, 'index.dom.js'),
		output: {
			sourcemap: !isProd,
			dir: join(dest, 'client'),
			minifyInternalExports: isProd,
			entryFileNames: isProd ? '[name].[hash].js' : '[name].js',
			assetFileNames: isProd ? '[name].[hash].[ext]' : '[name].[ext]',
			chunkFileNames: isProd ? '[name].[hash].js' : '[name].js',
		},
		preserveEntrySignatures: isProd ? false : 'strict',
		treeshake: isProd && {
			moduleSideEffects: 'no-external',
			tryCatchDeoptimization: false
		},
		plugins: [
			Plugin.Router,
			Plugin.Copy(options.copy),
			Plugin.Runtime(routes, true),
			Plugin.Summary({ isDOM: true }),
			require('@rollup/plugin-alias')(options.alias),
			// Assets.Plugin,
			require('@rollup/plugin-replace')({
				...options.replace,
				'__BROWSER__': 'true',
				'process.browser': 'true',
			}),
			require('@rollup/plugin-node-resolve').default({
				...options.resolve,
				rootDir: src
			}),
			require('@rollup/plugin-json')({
				compact: isProd,
				...options.json
			}),
			require('@rollup/plugin-commonjs')(options.commonjs),
			minify && require('rollup-plugin-terser').terser(options.terser)
		]
	};
}

export function Server(argv: Argv.Options, routes: Build.Route[], options: Config.Options, context: Config.Context): Rollup.Config {
	const { src, dest, minify } = argv;
	const { isProd } = context;

	return {
		// NOTE: may inject auto-detect
		input: join(src, 'index.ssr.js'),
		output: {
			file: join(dest, 'server', 'index.js'),
			minifyInternalExports: isProd,
			sourcemap: !isProd,
		},
		treeshake: {
			propertyReadSideEffects: false,
			moduleSideEffects: 'no-external',
			tryCatchDeoptimization: false
		},
		plugins: [
			Plugin.Runtime(routes, false),
			Plugin.Summary({ isDOM: false }),
			require('@rollup/plugin-alias')(options.alias),
			// Assets.Plugin,
			require('@rollup/plugin-replace')({
				...options.replace,
				'__BROWSER__': 'false',
				'process.browser': 'false',
			}),
			require('@rollup/plugin-node-resolve').default({
				...options.resolve,
				rootDir: src
			}),
			require('@rollup/plugin-json')({
				compact: isProd,
				...options.json
			}),
			minify && require('rollup-plugin-terser').terser(options.terser)
		]
	};
}
