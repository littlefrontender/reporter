const debug = require('debug')('@testomatio/reporter:pipe:testomatio');
const chalk = require('chalk');
const axios = require('axios');
const JsonCycle = require('json-cycle');
const { APP_PREFIX, STATUS } = require('../constants');
const { isValidUrl } = require('../util');
const { resetConfig } = require('../fileUploader');

const { TESTOMATIO_RUN } = process.env;
if (TESTOMATIO_RUN) {
  process.env.runId = TESTOMATIO_RUN;
}

/**
 * @typedef {import('../../types').Pipe} Pipe
 * @typedef {import('../../types').TestData} TestData
 * @class TestomatioPipe
 * @implements {Pipe}
 */
class TestomatioPipe {
  constructor(params, store) {
    this.isEnabled = false;
    this.url = params.testomatioUrl || process.env.TESTOMATIO_URL || 'https://app.testomat.io';
    this.apiKey = params.apiKey || process.env.TESTOMATIO;
    debug('Testomatio Pipe: ', this.apiKey ? 'API KEY' : '*no api key*');
    if (!this.apiKey) {
      return;
    }
    debug('Testomatio Pipe: Enabled');
    this.parallel = params.parallel;
    this.store = store || {};
    this.title = params.title || process.env.TESTOMATIO_TITLE;
    this.sharedRun = !!process.env.TESTOMATIO_SHARED_RUN;
    this.groupTitle = params.groupTitle || process.env.TESTOMATIO_RUNGROUP_TITLE;
    this.env = process.env.TESTOMATIO_ENV;
    this.axios = axios.create();
    this.isEnabled = true;
    // do not finish this run (for parallel testing)
    this.proceed = process.env.TESTOMATIO_PROCEED;
    this.runId = params.runId || process.env.runId;
    this.createNewTests = params.createNewTests ?? !!process.env.TESTOMATIO_CREATE;
    this.hasUnmatchedTests = false;

    if (!isValidUrl(this.url.trim())) {
      this.isEnabled = false;
      console.error(APP_PREFIX, chalk.red(`Error creating report on Testomat.io, report url '${this.url}' is invalid`));
    }
  }

  /**
   * @returns Promise<void>
   */
  async createRun() {
    if (!this.isEnabled) return;

    let buildUrl = process.env.BUILD_URL || process.env.CI_JOB_URL || process.env.CIRCLE_BUILD_URL;

    // GitHub Actions Url
    if (!buildUrl && process.env.GITHUB_RUN_ID) {
      // eslint-disable-next-line max-len
      buildUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    }

    // Azure DevOps Url
    if (!buildUrl && process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI) {
      const collectionUri = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
      const project = process.env.SYSTEM_TEAMPROJECT;
      const buildId = process.env.BUILD_BUILDID;
      buildUrl = `${collectionUri}/${project}/_build/results?buildId=${buildId}`;
    }

    if (buildUrl && !buildUrl.startsWith('http')) buildUrl = undefined;

    const accessEvent = process.env.TESTOMATIO_PUBLISH ? 'publish' : null;

    const runParams = Object.fromEntries(
      Object.entries({
        ci_build_url: buildUrl,
        parallel: this.parallel,
        api_key: this.apiKey.trim(),
        group_title: this.groupTitle,
        access_event: accessEvent,
        env: this.env,
        title: this.title,
        shared_run: this.sharedRun,
      }).filter(([, value]) => !!value)
    );

    if (this.runId) {
      const resp = await this.axios.put(`${this.url.trim()}/api/reporter/${this.runId}`, runParams);
      if (resp.data.artifacts) setS3Credentials(resp.data.artifacts);
      return;
    }

    try {
      const resp = await this.axios.post(`${this.url.trim()}/api/reporter`, runParams, {
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      this.runId = resp.data.uid;
      this.runUrl = `${this.url}/${resp.data.url.split('/').splice(3).join('/')}`;
      this.runPublicUrl = resp.data.public_url;
      if (resp.data.artifacts) setS3Credentials(resp.data.artifacts);
      this.store.runUrl = this.runUrl;
      this.store.runPublicUrl = this.runPublicUrl;
      this.store.runId = this.runId;
      console.log(APP_PREFIX, '📊 Report created. Report ID:', this.runId);
      process.env.runId = this.runId;
    } catch (err) {
      console.error(
        APP_PREFIX,
        'Error creating Testomat.io report, please check if your API key is valid. Skipping report',
      );
    }
  }

  /**
   * 
   * @param testData data 
   * @returns 
   */
  addTest(data) {
    if (!this.isEnabled) return;
    if (!this.runId) return;
    data.api_key = this.apiKey;
    data.create = this.createNewTests;
    const json = JsonCycle.stringify(data);

    return this.axios.post(`${this.url}/api/reporter/${this.runId}/testrun`, json, {
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        // Overwrite Axios's automatically set Content-Type
        'Content-Type': 'application/json',
      },
    })
    .catch((err) => {
      if (err.response) {
        if (err.response.status >= 400) {
          const responseData = err.response.data || { message: '' };
          console.log(
            APP_PREFIX,
            chalk.yellow(`Warning: ${responseData.message} (${err.response.status})`),
            chalk.grey(data?.title || ''),
          );
          if (err.response.data.message.includes('could not be matched')) {
            this.hasUnmatchedTests = true;
          }          
          return;
        }
        // eslint-disable-next-line max-len
        console.log(APP_PREFIX, chalk.blue(data?.title || ''), `Report couldn't be processed: ${err.response.data.message}`);
      } else {
        console.log(APP_PREFIX, chalk.blue(data?.title || ''), "Report couldn't be processed", err);
      }
    });
  }

  /**
   * @param {import('../../types').RunData} params 
   * @returns 
   */
  async finishRun(params) {
    if (!this.isEnabled) return;

    const { status, parallel } = params;

    let status_event;

    if (status === STATUS.FINISHED) status_event = 'finish';
    if (status === STATUS.PASSED) status_event = 'pass';
    if (status === STATUS.FAILED) status_event = 'fail';
    if (parallel) status_event += '_parallel';

    try {
      if (this.runId && !this.proceed) {
        await this.axios.put(`${this.url}/api/reporter/${this.runId}`, {
          api_key: this.apiKey,
          status_event,
          tests: params.tests,
        });
        if (this.runUrl) {
          console.log(APP_PREFIX, '📊 Report Saved. Report URL:', chalk.magenta(this.runUrl));
        }
        if (this.runPublicUrl) {
          console.log(APP_PREFIX, '🌟 Public URL:', chalk.magenta(this.runPublicUrl));
        }
        
      }
      if (this.runUrl && this.proceed) {
        const notFinishedMessage = chalk.yellow.bold('Run was not finished because of $TESTOMATIO_PROCEED');
        console.log(APP_PREFIX, `📊 ${notFinishedMessage}. Report URL: ${chalk.magenta(this.runUrl)}`);
        console.log(APP_PREFIX, `🛬 Run to finish it: TESTOMATIO_RUN=${this.runId} npx start-test-run --finish`);
      }
      if (this.hasUnmatchedTests) {
        console.log('');
        // eslint-disable-next-line max-len
        console.log(APP_PREFIX, chalk.yellow.bold('⚠️ Some reported tests were not found in Testomat.io project'));
        // eslint-disable-next-line max-len
        console.log(APP_PREFIX, `If you use Testomat.io as a reporter only, please re-run tests using ${chalk.bold('TESTOMATIO_CREATE=1')}`);
        // eslint-disable-next-line max-len
        console.log(APP_PREFIX, `But to keep your tests consistent it is recommended to ${chalk.bold('import tests first')}`);
        console.log(APP_PREFIX, 'If tests were imported but still not matched, assign test IDs to your tests.');
        console.log(APP_PREFIX, 'You can do that automatically via command line tools:');
        console.log(APP_PREFIX, chalk.bold('npx check-tests ... --update-ids'), 'See: https://bit.ly/js-update-ids');
        console.log(APP_PREFIX, 'or for Cucumber:');
        // eslint-disable-next-line max-len
        console.log(APP_PREFIX, chalk.bold('npx check-cucumber ... --update-ids'), 'See: https://bit.ly/bdd-update-ids');
      }
    } catch (err) {
      console.log(APP_PREFIX, 'Error updating status, skipping...', err);
    }
  }

  toString() {
    return 'Testomatio Reporter';
  }
}

module.exports = TestomatioPipe;


function setS3Credentials(artifacts) {  
  if (!Object.keys(artifacts).length) return;

  console.log(APP_PREFIX, 'S3 were credentials obtained from Testomat.io...');

  if (artifacts.ACCESS_KEY_ID) process.env.S3_ACCESS_KEY_ID = artifacts.ACCESS_KEY_ID; 
  if (artifacts.SECRET_ACCESS_KEY) process.env.S3_SECRET_ACCESS_KEY = artifacts.SECRET_ACCESS_KEY; 
  if (artifacts.REGION) process.env.S3_REGION = artifacts.REGION; 
  if (artifacts.BUCKET) process.env.S3_BUCKET = artifacts.BUCKET; 
  if (artifacts.ENDPOINT) process.env.S3_ENDPOINT = artifacts.ENDPOINT; 
  if (artifacts.presign) process.env.TESTOMATIO_PRIVATE_ARTIFACTS = '1'; 
  resetConfig();
}
