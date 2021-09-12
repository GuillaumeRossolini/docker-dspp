#!/usr/bin/env node
'use strict';


const {version : DSPP_VERSION } = require('./package.json');

const fs   = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;

const deepMixIn  = require('mout/object/deepMixIn');
const mkdirpSync = require('nyks/fs/mkdirpSync');
const prompt     = require('cnyks/prompt/prompt');
const md5        = require('nyks/crypto/md5');
const tmppath    = require('nyks/fs/tmppath');
const wait       = require('nyks/child_process/wait');

const yaml = require('js-yaml');

function passthru(cmd) {
  let child = spawn(cmd, {shell : '/bin/bash', stdio : 'inherit'});
  return wait(child);
}

const CACHE_STACK_PATH = ".docker-stack";
const CACHE_CAS_PATH   = path.join(CACHE_STACK_PATH, ".cas");

class dspp {

  constructor(config_file, filter = null) {
    if(!fs.existsSync(config_file))
      throw `Usage dspp [config_file]`;

    this.config_file = config_file;
    this.filter      = filter;

    mkdirpSync(CACHE_STACK_PATH);
    mkdirpSync(CACHE_CAS_PATH);
  }


  async _parse() {
    let process_config = true;

    let {config_file, filter} = this;

    let config = fs.readFileSync(config_file, 'utf-8');
    config = yaml.load(config);

    let stack_ns   = config.ns || path.basename(config_file, '.yml');

    if(filter) {
      stack_ns = `${stack_ns}.${filter}`;
      console.log("Filter stack for '%s'", filter);
    }

    this.stack_name = config.name || stack_ns;

    console.log(`Working with stack '%s@%s' from %d files and %d env files`, this.stack_name, stack_ns, config.files.length, config['env-files'].length);


    let env = '';
    for(let compose_file of config['env-files'])
      env += fs.readFileSync(compose_file, 'utf-8') + `\n`;

    let stack = '';
    for(let compose_file of config.files)
      stack += env + fs.readFileSync(compose_file, 'utf-8') + `\n---\n`;


    this.current_stack   = `.docker-stack/${stack_ns}.yml`;

    console.log("Working in %s", this.current_stack);

    let out = {};
    yaml.loadAll(stack, doc => deepMixIn(out, doc));
    out = sortObjByKey(out);


    // strip all filtered services
    if(filter) {
      let valid_configs = [];

      for(let [service_name, service] of Object.entries(out.services)) {
        if(service_name.indexOf(filter) === -1)
          delete out.services[service_name];
        for(let config of service.configs || [])
          valid_configs.push(config.source);
      }

      for(let config_name in out.configs) {
        if(!valid_configs.includes(config_name))
          delete out.configs[config_name];
      }
    }


    if(process_config) {
      let config_map = {};
      for(let [config_name, config] of Object.entries(out.configs)) {
        if(config.external)
          continue;

        let {cas_path, cas_name} = config_map[config_name] = await this._cas(config_name, config);
        out.configs[cas_name] = {...out.configs[config_name], file : cas_path};
        delete out.configs[config_name];
      }

      for(let service of Object.values(out.services)) {
        for(let config of service.configs || []) {
          if(config_map[config.source])
            config.source = config_map[config.source]['cas_name'];
        }
      }
    }


    let body = yaml.dump({
      version  : out.version,
      configs  : out.configs,
      secrets  : out.secrets,
      networks : out.networks,
      volumes  : out.volumes,
      services : out.services
    }, {quotingType : '"', lineWidth : -1, noCompatMode : true});

    let stack_revision = md5(stack + body).substr(0, 5); //source + compiled
    let header = `# ${this.stack_name}:${stack_ns} @${stack_revision} (dspp v${DSPP_VERSION})\n`;
    this.compiled = header + body;
  }


  async compile() {
    await this._parse();

    let before = fs.existsSync(this.current_stack) ? this.current_stack : "/dev/null";

    if(fs.readFileSync(before, 'utf-8') == this.compiled)
      return console.log("No changes detected");

    let style = 0, commit;

    let next = tmppath();
    fs.writeFileSync(next, this.compiled);

    do {

      if(style == 1)
        await passthru(`diff -y <(echo -e "current stack\\n---"; cat "${before}") <(echo -e "next stack\n---"; cat  "${next}") | colordiff | most`);

      if(style == 0)
        await passthru(`cat "${next}" | git diff --no-index "${before}" - || true`);

      try {
        commit = await prompt("Confirm [y/N/q] (q : toggle diff style):");
      } catch(err) {
        break;
      }
      commit = commit.toLowerCase();
      if(commit != "q")
        break;

      style ^= 1;
    } while(true);

    if(commit == "y") {
      fs.writeFileSync(this.current_stack, this.compiled);
      console.log("Stack wrote in", this.current_stack);
    }

  }

  async deploy() {
    await this._parse();

    if(!fs.existsSync(this.current_stack) || fs.readFileSync(this.current_stack, 'utf-8') != this.compiled)
      return console.log("Change detected, please compile first");

    await passthru(`docker stack deploy --with-registry-auth --compose-file - ${this.stack_name} < "${this.current_stack}"`);
    await passthru(`docker service ls`);
  }

  // import
  async _cas(config_name, {file : config_file}) {
    let contents = fs.readFileSync(config_file);
    let hash     = md5(contents);
    let cas_path = path.join(CACHE_CAS_PATH, hash);
    let cas_name = config_name + '-' + hash.substr(0, 5);
    if(fs.existsSync(cas_path))
      return {hash, cas_path, cas_name};
    fs.writeFileSync(cas_path, contents);
    return {hash, cas_path, cas_name};
  }
}


function sortObjByKey(value) {
  if(value === null)
    return value;

  return (typeof value === 'object') ?
    (Array.isArray(value) ?
      value.map(sortObjByKey) :
      Object.keys(value).sort().reduce(
        (o, key) => {
          const v = value[key];
          o[key] = sortObjByKey(v);
          return o;
        }, {})
    ) :
    value;
}




if(module.parent === null) //ensure module is called directly, i.e. not required
  require('cnyks/lib/bundle')(dspp); //start runner

module.exports = dspp;
