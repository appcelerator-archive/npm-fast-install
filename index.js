/**
 * Installs and caches modules from npm.
 *
 * @copyright
 * Copyright (c) 2015 by Appcelerator, Inc. All Rights Reserved.
 *
 * @license
 * Licensed under the terms of the Apache Public License.
 * Please see the LICENSE included with this distribution for details.
 */

'use strict';

module.exports.install = install;

var async = require('async');
var fs = require('fs-extra');
var npm = require('npm');
var path = require('path');
var pluralize = require('pluralize');
var Promise = Promise || require('q').Promise;
var semver = require('semver');
var tmp = require('tmp');

/**
 * Installs a module from npm and caches it.
 *
 * @param {object} [opts] - Various options.
 * @param {boolean} [opts.allowShrinkwrap] - When true, tells npm to honor shrinkwrap settings.
 * @param {string} [opts.cacheDir=~/.npm-fast-install] - The directory to cache modules.
 * @param {string} [opts.dir=`cwd`] - The directory containing the package.json.
 * @param {stream} [opts.logger] - A logger to use such as `console`.
 * @param {number} [opts.maxTasks=5] - The maximum number of npm install jobs to run simultaneously.
 * @param {boolean} [opts.production] - When true, installs only dependencies, not dev dependencies.
 *
 * @returns {Promise} A promise object
 */
function install(opts) {
    return (new Promise(function (fulfill, reject) {
        if (!opts || typeof opts !== 'object') {
            opts = {};
        }

        // check directory
        var dir = resolvePath(opts.dir || process.cwd());
        if (!fs.existsSync(dir)) {
            return reject(new Error('Invalid directory: ' + dir));
        }

        // init logger
        var logger = opts.logger && typeof opts.logger === 'object' ? opts.logger : {};
        ['log', 'debug', 'info', 'warn', 'error'].forEach(function (lvl) { typeof logger[lvl] === 'function' || (logger[lvl] = function () {}); });

        var modulesAPI = parseInt(process.versions.modules) || (function (m) {
                return !m || m[1] === '0.8' ? 1 : m[1] === '0.10' ? 11 : m[1] === '0.11' && m[2] < 8 ? 12 : 13;
            }(process.version.match(/^v(\d+\.\d+)\.(\d+)$/)));

        logger.info('Node.js version: %s', process.version);
        logger.info('Architecture:    %s', process.arch);
        logger.info('Module version:  %s', modulesAPI);
        logger.info('npm version:     %s', npm.version + '\n');

        // load the package.json
        var pkgJsonFile = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgJsonFile)) {
            return reject(new Error('No package.json found'));
        }
        logger.info('Loading package.json: %s', pkgJsonFile);

        var pkgJson = require(pkgJsonFile);
        var deps = pkgJson.dependencies && typeof pkgJson.dependencies === 'object' ? Object.keys(pkgJson.dependencies).map(function (dep) {
            return {name: dep, ver: pkgJson.dependencies[dep]};
        }) : [];
        if(!opts.production && pkgJson.devDependencies && typeof pkgJson.devDependencies === 'object') {
            Array.prototype.push.apply(deps, Object.keys(pkgJson.devDependencies).map(function (dep) {
                    return {name: dep, ver: pkgJson.devDependencies[dep]};
                }));
        }
        var results = {
            node: process.version,
            arch: process.arch,
            modulesAPI: modulesAPI,
            modules: {}
        };

        if (!deps.length) {
            // if there are no deps, return now
            return fulfill(results);
        }

        logger.info('Found %s %s\n', deps.length, pluralize('dependency', deps.length));

        // init the cache dir
        var cacheDir = resolvePath(opts.cacheDir || '~/.npm-fast-install');
        if (!fs.existsSync(cacheDir)) {
            logger.info('Initializing cache dir: %s', cacheDir);
            fs.mkdirsSync(cacheDir);
        }

        var destNodeModulesDir = path.join(dir, 'node_modules');
        fs.existsSync(destNodeModulesDir) || fs.mkdirsSync(destNodeModulesDir);

        // init npm
        npm.load({
            global: false,
            production: opts.production,
            shrinkwrap: !!opts.allowShrinkwrap,
            color: false,
            // it's impossible to completely silence npm and node-gyp
            loglevel: 'silent',
            progress: false
        }, function (err) {
            if (err) { return cb(err); }

            async.eachLimit(deps, opts.maxTasks || 5, function (dep, cb) {
                if (semver.valid(dep.ver)) {
                    var cacheModuleDir = path.join(cacheDir, dep.name, dep.ver, process.arch, String(modulesAPI));
                    if (fs.existsSync(cacheModuleDir)) {
                        logger.info('Installing %s@%s from cache: %s', dep.name, dep.ver, cacheModuleDir);
                        return copyDir(cacheModuleDir, destNodeModulesDir, cb);
                    }
                }

                npm.commands.view([dep.name], true, function (err, infos) {
                    if (err) { return cb(err); }

                    var info = infos[Object.keys(infos).shift()];
                    var ver = dep.ver === '*' || dep.ver === 'latest' ? info.version : semver.maxSatisfying(info.versions, dep.ver + ' <=' + info.version);
                    var cacheModuleDir = path.join(cacheDir, dep.name, ver, process.arch, String(modulesAPI));
                    var dest = path.join(destNodeModulesDir, dep.name);

                    results.modules[dep.name] = {
                        version: ver,
                        path: dest,
                        info: info
                    };

                    // do we have it cached?
                    if (fs.existsSync(cacheModuleDir)) {
                        logger.info('Installing %s@%s from cache: %s', dep.name, ver, cacheModuleDir);
                        return copyDir(cacheModuleDir, destNodeModulesDir, cb);
                    }

                    // need to install it
                    logger.info('Fetching %s@%s', dep.name, ver);
                    var tmpDir = tmp.dirSync({ prefix: 'npm-fast-install-' }).name;
                    npm.commands.install(tmpDir, [dep.name + '@' + ver], function (err) {
                        if (err) { return cb(err); }

                        function next(err) {
                            // remove the tmp dir
                            fs.removeSync(tmpDir);
                            if (err) { return cb(err); }

                            // copy the module from the cache
                            logger.info('Installing %s@%s\n', dep.name, ver);
                            copyDir(cacheModuleDir, destNodeModulesDir, cb);
                        }

                        // double check that the dest doesn't already exist
                        if (fs.existsSync(cacheModuleDir)) {
                            next();
                        } else {
                            logger.info('Caching %s@%s %s', dep.name, ver, cacheModuleDir);
                            fs.move(path.join(tmpDir, 'node_modules'), cacheModuleDir, next);
                        }
                    });
                });
            }, function (err) {
                err ? reject(err) : fulfill(results);
            });
        });
    }));
}

/**
 * Recursively copies a directory.
 *
 * @param {string} src - The source directory to copy.
 * @param {string} dest - The destination directory to copy to.
 * @param {function} cb - A callback to fire when copying is complete.
 */
function copyDir(src, dest, cb) {
    // since we're processing multiple packages simultaneously, fs-extra's
    // copy() falls over when copying two packages with a same named subdir
    // (such as ".bin"), so we manually loop over the the top level directories
    async.eachSeries(fs.readdirSync(src), function (name, next) {
        var dir = path.join(dest, name);
        fs.existsSync(dir) || fs.mkdirsSync(dir);
        fs.copy(path.join(src, name), dir, next);
    }, cb);
}

/**
 * Resolves a path including home directories.
 *
 * @param {string} dir - One or more path segments.
 *
 * @returns {string} The resovled path.
 */
function resolvePath(dir) {
    var win = process.platform === 'win32';
    var p = path.join.apply(null, arguments).replace(/^(~)([\\\/].*)?$/, function (s, m, n) {
        return process.env[win ? 'USERPROFILE' : 'HOME'] + (n || '/');
    });
    return path.resolve(win ? p.replace(/(%([^%]*)%)/g, function (s, m, n) {
        return process.env[n] || m;
    }) : p).replace(/[\/\\]/g, path.sep);
}