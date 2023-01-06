import { dirname, join } from 'path';
import {
  debug,
  download,
  execCommand,
  getNodeVersion,
  getSpawnOptions,
  readConfigFile,
  runNpmInstall,
  runPackageJsonScript,
  scanParentDirs,
  BuildV2,
  PackageJson,
  glob,
  getEnvForPackageManager,
} from '@vercel/build-utils';
import {
  createAPIRoutes,
  createFunctionLambda,
  createServerlessFunction,
} from './helpers/functions';
import { createStaticOutput } from './helpers/static';
import { getTransformedRoutes, Rewrite } from '@vercel/routing-utils';

function hasScript(scriptName: string, pkg: PackageJson | null) {
  const scripts = (pkg && pkg.scripts) || {};
  return typeof scripts[scriptName] === 'string';
}

export const build: BuildV2 = async ({
  entrypoint,
  files,
  workPath,
  config,
  meta = {},
}) => {
  console.log('@vercel/gatsby!');

  await download(files, workPath, meta);

  const { installCommand, buildCommand } = config;
  const mountpoint = dirname(entrypoint);
  const entrypointFsDirname = join(workPath, mountpoint);
  console.log('entrypointFsDirname', entrypoint)
  const nodeVersion = await getNodeVersion(
    entrypointFsDirname,
    undefined,
    config,
    meta
  );

  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  const { cliType, lockfileVersion } = await scanParentDirs(
    entrypointFsDirname
  );

  spawnOpts.env = getEnvForPackageManager({
    cliType,
    lockfileVersion,
    nodeVersion,
    env: spawnOpts.env || {},
  });

  if (typeof installCommand === 'string') {
    if (installCommand.trim()) {
      console.log(`Running "install" command: \`${installCommand}\`...`);

      await execCommand(installCommand, {
        ...spawnOpts,
        cwd: entrypointFsDirname,
      });
    } else {
      console.log(`Skipping "install" command...`);
    }
  } else {
    await runNpmInstall(entrypointFsDirname, [], spawnOpts, meta, nodeVersion);
  }

  // Run "Build Command"
  if (buildCommand) {
    debug(`Executing build command "${buildCommand}"`);
    await execCommand(buildCommand, {
      ...spawnOpts,
      cwd: entrypointFsDirname,
    });
  } else {
    const pkg = await readConfigFile<PackageJson>(
      join(entrypointFsDirname, 'package.json')
    );
    if (hasScript('vercel-build', pkg)) {
      debug(`Executing "yarn vercel-build"`);
      await runPackageJsonScript(
        entrypointFsDirname,
        'vercel-build',
        spawnOpts
      );
    } else if (hasScript('build', pkg)) {
      debug(`Executing "yarn build"`);
      await runPackageJsonScript(entrypointFsDirname, 'build', spawnOpts);
    } else {
      await execCommand('gatsby build', {
        ...spawnOpts,
        cwd: entrypointFsDirname,
      });
    }
  }

  function getPages() {
    const curDir = process.cwd();
    // Change dir into `entrypointFsDirname` to get correct `pages` from redux store.
    process.chdir(entrypointFsDirname);

    // Need to resolve absolute import path in order to load project's version of `gatsby`.
    const gatsbyPkgPath = require.resolve('gatsby/package.json', {
      paths: [entrypointFsDirname],
    });
    const reduxPath = join(gatsbyPkgPath, '../dist/redux');
    console.log({ reduxPath });
    const state = require(reduxPath).store.getState();
    console.log('state', state);
    const pages = state.pages;
    console.log('pages', pages);
    process.chdir(curDir);
    return pages;
  }

  const vercelConfig = await readConfigFile<{
    redirects?: [];
    rewrites?: [];
  }>(join(entrypointFsDirname, 'vercel.json'));

  const { ssrRoutes, dsgRoutes } = [...getPages().values()].reduce(
    (acc, cur) => {
      if (cur.mode === 'SSR') {
        acc.ssrRoutes.push(cur.path);
      } else if (cur.mode === 'DSG') {
        acc.dsgRoutes.push(cur.path);
      }

      return acc;
    },
    {
      ssrRoutes: [],
      dsgRoutes: [],
    }
  );
  console.log('ssrRoutes', ssrRoutes, 'dsgRoutes', dsgRoutes);
  const functions = await glob('**', join(entrypointFsDirname, 'src', 'api'));

  const { routes } = getTransformedRoutes({
    trailingSlash: false,
    rewrites: [
      ...((vercelConfig?.rewrites as Rewrite[]) || []),
      ...(Object.keys(functions).length
        ? [{ source: '/page-data(.*)', destination: '/_page-data' }]
        : []),
    ],
    redirects: vercelConfig?.redirects,
  });

  const result = {
    output: {
      ...(await createStaticOutput({
        staticDir: join(entrypointFsDirname, 'public'),
      })),
      ...(Object.keys(functions).length &&
        (await createAPIRoutes({ functions, nodeVersion }))),
      ...((dsgRoutes.length || ssrRoutes.length) && {
        ...(await createServerlessFunction({
          ssrRoutes,
          dsgRoutes,
          nodeVersion,
        })),
        '_page-data': await createFunctionLambda({
          nodeVersion,
          handlerFile: join(__dirname, 'handlers', 'templates', 'page-data'),
        }),
      }),
    },
    routes: routes || undefined,
  };

  // console.log(result);

  return result;
};
