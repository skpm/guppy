// @flow
import asyncMap from 'async/map';
import * as fs from 'fs';
import * as path from 'path';

import { pick } from '../utils';

import type { Stats } from 'fs';
import type {
  QueuedDependency,
  DependencyLocation,
  Dependency,
  ProjectInternal,
} from '../types';

type JSONObject = { [key: string]: any };

/**
 * Load createdAt time
 */
export const loadProjectFSStat = (projectPath: string) => {
  return new Promise<Stats>((resolve, reject) => {
    return fs.stat(projectPath, (err, data) => {
      if (err) {
        return reject(err);
      }
      return resolve(data);
    });
  });
};

/**
 * Load a project's package.json
 */
export const loadPackageJson = (projectPath: string) => {
  return new Promise<JSONObject>((resolve, reject) => {
    return fs.readFile(
      path.join(projectPath, 'package.json'),
      'utf8',
      (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(JSON.parse(data));
      }
    );
  });
};

/**
 * Load a project's manifest.json
 */
export const loadManifestJson = (
  projectPath: string,
  packageJson: JSONObject
) => {
  return new Promise<JSONObject>((resolve, reject) => {
    return fs.readFile(
      path.join(projectPath, packageJson.skpm.manifest),
      'utf8',
      (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(JSON.parse(data));
      }
    );
  });
};

/**
 * Load a project's icon.png
 */
export const loadIcon = (projectPath: string) => {
  return new Promise<string>((resolve, reject) => {
    return fs.readFile(
      path.join(projectPath, 'assets', 'icon.png'),
      'base64',
      (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      }
    );
  });
};

/**
 * Update a project's package.json.
 */
export const writePackageJson = (projectPath: string, json: any) => {
  const prettyPrintedPackageJson = JSON.stringify(json, null, 2);

  return new Promise<JSONObject>((resolve, reject) => {
    fs.writeFile(
      path.join(projectPath, 'package.json'),
      prettyPrintedPackageJson,
      err => {
        if (err) {
          return reject(err);
        }

        resolve(json);
      }
    );
  });
};

export const writeManifestJson = (
  projectPath: string,
  packageJson: JSONObject,
  json: JSONObject
) => {
  const prettyPrintedManifestJson = JSON.stringify(json, null, 2);

  return new Promise<JSONObject>((resolve, reject) => {
    fs.writeFile(
      path.join(projectPath, packageJson.skpm.manifest),
      prettyPrintedManifestJson,
      err => {
        if (err) {
          return reject(err);
        }

        resolve(json);
      }
    );
  });
};

export const loadProject = (projectPath: string): Promise<ProjectInternal> => {
  return loadPackageJson(projectPath).then(json =>
    Promise.all([
      loadManifestJson(projectPath, json).catch(console.error),
      loadIcon(projectPath).catch(console.error),
      loadProjectFSStat(projectPath).catch(console.error),
    ]).then(([manifest, icon, stat]) => {
      json.__skpm_manifest = manifest;
      json.__skpm_icon = icon;
      json.__skpm_createdAt = (stat || {}).birthtimeMs;
      return json;
    })
  );
};

/**
 * Given an array of paths, load each one as a distinct project.
 */
export const loadProjects = (projectPaths: Array<string>) =>
  new Promise<{ [projectId: string]: ProjectInternal }>((resolve, reject) => {
    // Each project in a Guppy directory should have a package.json.
    // We'll read all the project info we need from this file.
    // TODO: Maybe use asyncReduce to handle the output format in 1 neat step?
    asyncMap(
      projectPaths,
      function(projectPath, callback) {
        loadProject(projectPath)
          .then(json => callback(null, json))
          .catch(err =>
            // If the package.json couldn't be loaded, this likely means the
            // project was deleted, and our cache is out-of-date.
            // This isn't truly an error, it just means we need to ignore this
            // project.
            // TODO: Handle other errors!
            callback(null, null)
          );
      },
      (err, results) => {
        // It's possible that the project was deleted since Guppy last checked.
        // Ignore any `null` results.
        // If the project was deleted, an exception is caught, and so `err`
        // might not be a true error.
        // TODO: Handle true errors tho!
        if (!results) {
          return reject(err);
        }

        // a `null` result means the project couldn't be loaded, probably
        // because it was deleted.
        // TODO: Maybe a warning prompt should be raised if this is the case,
        // so that users don't wonder where the project went?
        const validProjects = results.filter(project => !!project);

        // The results will be an array of package.jsons.
        // I want a database-style map.
        const projects = validProjects.reduce(
          (projectsMap, project) => ({
            ...projectsMap,
            [project.name]: project,
          }),
          {}
        );

        resolve(projects);
      }
    );
  });

/**
 * Find a specific project's dependency information.
 * While all guppy projects have basic info already loaded in via the project's
 * package.json, it would be nice to learn more about the dependencies.
 *
 * We want information such as:
 *   - The specific version number installed (not just the acceptable range)
 *   - The dependency's description
 *   - The dependency's authors or maintainers
 *   - Links to homepage / git repo
 *   - Software license
 *
 * This method reads the package.json for a specific dependency, in a specific
 * project.
 */
export function loadProjectDependency(
  projectPath: string,
  dependencyName: string,
  dependencyLocation: DependencyLocation = 'dependencies'
) {
  // prettier-ignore
  const dependencyPath = path.join(projectPath, 'node_modules', dependencyName, 'package.json');

  return new Promise<Dependency | null>((resolve, reject) => {
    fs.readFile(dependencyPath, 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // Interestingly, freshly-ejected packages have `babel-loader`
          // as a dependency, but no such NPM module installed o_O.
          // Maybe it isn't a safe bet to assume that dependency name
          // always matches folder name inside `node_modules`?
          // TODO: For now I'm just going to ignore these cases, but I should
          // really figure this out!
          return resolve(null);
        }

        return reject(err);
      }

      const packageJson = JSON.parse(data);

      const packageJsonSubset = pick(packageJson, [
        'name',
        'description',
        'keywords',
        'version',
        'homepage',
        'license',
        'repository',
      ]);

      const dependency = {
        ...packageJsonSubset,
        status: 'idle',
        location: dependencyLocation,
      };

      // $FlowFixMe
      return resolve(dependency);
    });
  });
}

/**
 * Wrapper around `loadProjectDependency` that fetches all dependencies from
 * an array.
 */
export function loadProjectDependencies(
  projectPath: string,
  dependencies: Array<QueuedDependency>
) {
  return new Promise<Array<Dependency>>((resolve, reject) => {
    asyncMap(
      dependencies,
      function({ name, location }, callback) {
        loadProjectDependency(projectPath, name, location)
          .then(dependency => callback(null, dependency))
          .catch(callback);
      },
      (err, results) => {
        if (err) {
          return reject(err);
        }

        // Filter out any unloaded dependencies
        const filteredResults = results.filter(result => result);

        resolve(filteredResults);
      }
    );
  });
}

/**
 * Wrapper around `loadProjectDependency` that fetches all dependencies for
 * a specific project.
 *
 * NOTE: I wonder how this would perform on a project with 100+ top-level
 * dependencies... might need to set up a streaming service that can communicate
 * loading status if it takes more than a few hundred ms.
 */
export function loadAllProjectDependencies(projectPath: string) {
  // Get a fresh copy of the dependencies from the project's package.json
  return loadPackageJson(projectPath).then(
    packageJson =>
      new Promise((resolve, reject) => {
        const deps = Object.keys(packageJson.dependencies || {});
        const devDeps = Object.keys(packageJson.devDependencies || {});
        const dependencies = [...deps, ...devDeps].map(name => ({
          name,
          location: devDeps.includes(name) ? 'devDependencies' : 'dependencies',
        }));

        loadProjectDependencies(projectPath, dependencies).then(
          dependenciesFromPackageJson => {
            // The results will be an array of package.jsons.
            // I want a database-style map.
            const dependenciesByName = dependenciesFromPackageJson.reduce(
              (dependenciesMap, dependency) => ({
                ...dependenciesMap,
                [dependency.name]: dependency,
              }),
              {}
            );

            resolve(dependenciesByName);
          }
        );
      })
  );
}

export const createCommandJs = (
  projectPath: string,
  packageJson: JSONObject,
  commandPath: string
) => {
  return new Promise<void>((resolve, reject) => {
    fs.writeFile(
      path.resolve(
        path.dirname(path.join(projectPath, packageJson.skpm.manifest)),
        commandPath
      ),
      `import sketch from 'sketch'
// documentation: https://developer.sketchapp.com/reference/api/

export default function() {
  sketch.UI.message("It's alive 🙌")
}
`,
      err => {
        if (err) {
          return reject(err);
        }
        resolve();
      }
    );
  });
};
