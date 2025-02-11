const { URL } = require('url');
const { sep, basename } = require('path');
const chalk = require('chalk');
const fs = require('fs');
const isValid = require('is-valid-path');
const debug = require('debug')('@testomatio/reporter:util');

/**
 * @param {String} testTitle - Test title
 *
 * @returns {String|null} testId
 */
const parseTest = testTitle => {
  if (!testTitle) return null;

  const captures = testTitle.match(/@T([\w\d]+)/);

  if (captures) {
    return captures[1];
  }

  return null;
};

/**
 * @param {String} suiteTitle - suite title
 *
 * @returns {String|null} suiteId
 */
const parseSuite = suiteTitle => {
  const captures = suiteTitle.match(/@S([\w\d]+)/);
  if (captures) {
    return captures[1];
  }

  return null;
};

const ansiRegExp = () => {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|');

  return new RegExp(pattern, 'g');
};

const isValidUrl = s => {
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return true;
  } catch (err) {
    return false;
  }
};

const fetchFilesFromStackTrace = (stack = '') => {
  const files = stack.matchAll(/file:?\/(\/.*?\.(png|avi|webm|jpg|html|txt))/g);
  return Array.from(files)
    .map(f => f[1])
    .filter(f => fs.existsSync(f));
};

const fetchSourceCodeFromStackTrace = (stack = '') => {
  const stackLines = stack
    .split('\n')
    .filter(l => l.includes(':'))
    // .map(l => l.match(/\[(.*?)\]/)?.[1] || l) // minitest format
    // .map(l => l.split(':')[0])
    .map(l => l.trim())
    .map(l => l.split(' ').find(p => p.includes(':')) || '')
    .filter(l => isValid(l?.split(':')[0]))

    // // filter out 3rd party libs
    .filter(l => !l?.includes(`vendor${sep}`))
    .filter(l => !l?.includes(`node_modules${sep}`))
    .filter(l => fs.existsSync(l.split(':')[0]))
    .filter(l => fs.lstatSync(l.split(':')[0]).isFile());

  if (!stackLines.length) return '';

  const [file, line] = stackLines[0].split(':');

  const prepend = 3;
  const source = fetchSourceCode(fs.readFileSync(file).toString(), { line, prepend, limit: 7 });

  if (!source) return '';

  return source
    .split('\n')
    .map((l, i) => {
      if (i === prepend) return `${line} > ${chalk.bold(l)}`;
      return `${line - prepend + i} | ${l}`;
    })
    .join('\n');
};

const fetchSourceCode = (contents, opts = {}) => {
  if (!opts.title && !opts.line) return '';

  // code fragment is 20 lines
  const limit = opts.limit || 50;
  let lineIndex;
  if (opts.line) lineIndex = opts.line - 1;
  const lines = contents.split('\n');

  // remove special chars from title
  if (!lineIndex && opts.title) {
    const title = opts.title.replace(/[([@].*/g, '');
    lineIndex = lines.findIndex(l => l.includes(title));
  }

  if (opts.prepend) {
    lineIndex -= opts.prepend;
  }

  if (lineIndex) {
    const result = [];
    for (let i = lineIndex; i < lineIndex + limit; i++) {
      if (lines[i] === undefined) continue;

      if (i > lineIndex + 2 && !opts.prepend) {
        // annotation
        if (opts.lang === 'php' && lines[i].trim().startsWith('#[')) break;
        if (opts.lang === 'php' && lines[i].includes(' private function ')) break;
        if (opts.lang === 'php' && lines[i].includes(' protected function ')) break;
        if (opts.lang === 'php' && lines[i].includes(' public function ')) break;
        if (opts.lang === 'python' && lines[i].trim().match(/^@\w+/)) break;
        if (opts.lang === 'python' && lines[i].includes(' def ')) break;
        if (opts.lang === 'ruby' && lines[i].includes(' def ')) break;
        if (opts.lang === 'ruby' && lines[i].includes(' test ')) break;
        if (opts.lang === 'ruby' && lines[i].includes(' it ')) break;
        if (opts.lang === 'ruby' && lines[i].includes(' specify ')) break;
        if (opts.lang === 'ruby' && lines[i].includes(' context ')) break;
        if (opts.lang === 'ts' && lines[i].includes(' it(')) break;
        if (opts.lang === 'ts' && lines[i].includes(' test(')) break;
        if (opts.lang === 'js' && lines[i].includes(' it(')) break;
        if (opts.lang === 'js' && lines[i].includes(' test(')) break;
        if (opts.lang === 'java' && lines[i].trim().match(/^@\w+/)) break;
        if (opts.lang === 'java' && lines[i].includes(' public void ')) break;
        if (opts.lang === 'java' && lines[i].includes(' class ')) break;
      }
      result.push(lines[i]);
    }
    return result.join('\n');
  }
};

const isSameTest = (test, t) =>
  typeof t === 'object' &&
  typeof test === 'object' &&
  t.title === test.title &&
  t.suite_title === test.suite_title &&
  Object.values(t.example || {}) === Object.values(test.example || {}) &&
  t.test_id === test.test_id;

const getCurrentDateTime = () => {
  const today = new Date();

  return `${today.getFullYear()}_${
    today.getMonth() + 1
  }_${today.getDate()}_${today.getHours()}_${today.getMinutes()}_${today.getSeconds()}`;
};

/**
 * @param {Object} test - Test adapter object
 *
 * @returns {String|null} testInfo as one string
 */
const specificTestInfo = test => {
  // TODO: afterEach has another context.... need to add specific handler, maybe...
  if (test?.title && test?.file) {
    return `${basename(test.file).split('.').join('#')}#${test.title.split(' ').join('#')}`;
  }

  return null;
};

const fileSystem = {
  createDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      debug('Created dir: ', dirPath);
    }
  },
  clearDir(dirPath) {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true });
      debug(`Dir ${dirPath} was deleted`);
    } else {
      debug(`Trying to delete ${dirPath} but it doesn't exist`);
    }
  },
};

const humanize = text => {
  text = decamelize(text);
  return text
    .replace(/_./g, match => ` ${match.charAt(1).toUpperCase()}`)
    .trim()
    .replace(/^(.)|\s(.)/g, $1 => $1.toUpperCase())
    .trim()
    .replace(/\sA\s/g, ' a ') // replace a|the
    .replace(/\sThe\s/g, ' the ') // replace a|the
    .replace(/^Test\s/, '')
    .replace(/^Should\s/, '');
};

/**
 * From https://github.com/sindresorhus/decamelize/blob/main/index.js
 * @param {*} text
 * @returns
 */
const decamelize = text => {
  const separator = '_';
  const replacement = `$1${separator}$2`;

  // Split lowercase sequences followed by uppercase character.
  // `dataForUSACounties` → `data_For_USACounties`
  // `myURLstring → `my_URLstring`
  let decamelized = text.replace(/([\p{Lowercase_Letter}\d])(\p{Uppercase_Letter})/gu, replacement);

  // Lowercase all single uppercase characters. As we
  // want to preserve uppercase sequences, we cannot
  // simply lowercase the separated string at the end.
  // `data_For_USACounties` → `data_for_USACounties`
  decamelized = decamelized.replace(
    /((?<![\p{Uppercase_Letter}\d])[\p{Uppercase_Letter}\d](?![\p{Uppercase_Letter}\d]))/gu,
    $0 => $0.toLowerCase(),
  );

  // Remaining uppercase sequences will be separated from lowercase sequences.
  // `data_For_USACounties` → `data_for_USA_counties`
  return decamelized.replace(
    /(\p{Uppercase_Letter}+)(\p{Uppercase_Letter}\p{Lowercase_Letter}+)/gu,
    (_, $1, $2) => $1 + separator + $2.toLowerCase(),
  );
};

/**
 * Used to remove color codes
 * @param {*} input
 * @returns
 */
function removeColorCodes(input) {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = {
  isSameTest,
  fetchSourceCode,
  fetchSourceCodeFromStackTrace,
  fetchFilesFromStackTrace,
  fileSystem,
  getCurrentDateTime,
  specificTestInfo,
  isValidUrl,
  ansiRegExp,
  parseTest,
  parseSuite,
  humanize,
  removeColorCodes,
};
