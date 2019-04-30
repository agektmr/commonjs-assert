const assert = require('../assert-loader');

const noop = () => {};

const mustCallChecks = [];

function runCallChecks(exitCode) {
  if (exitCode !== 0) return;

  const failed = mustCallChecks.filter(function(context) {
    if ('minimum' in context) {
      context.messageSegment = `at least ${context.minimum}`;
      return context.actual < context.minimum;
    } else {
      context.messageSegment = `exactly ${context.exact}`;
      return context.actual !== context.exact;
    }
  });

  failed.forEach(function(context) {
    console.log('Mismatched %s function calls. Expected %s, actual %d.',
                context.name,
                context.messageSegment,
                context.actual);
    console.log(context.stack.split('\n').slice(2).join('\n'));
  });

  if (failed.length) process.exit(1);
}

function mustCall(fn, exact) {
  return _mustCallInner(fn, exact, 'exact');
}

function mustCallAtLeast(fn, minimum) {
  return _mustCallInner(fn, minimum, 'minimum');
}

function _mustCallInner(fn, criteria = 1, field) {
  if (process._exiting)
    throw new Error('Cannot use common.mustCall*() in process exit handler');
  if (typeof fn === 'number') {
    criteria = fn;
    fn = noop;
  } else if (fn === undefined) {
    fn = noop;
  }

  if (typeof criteria !== 'number')
    throw new TypeError(`Invalid ${field} value: ${criteria}`);

  const context = {
    [field]: criteria,
    actual: 0,
    stack: (new Error()).stack,
    name: fn.name || '<anonymous>'
  };

  // Add the exit listener only once to avoid listener leak warnings
  if (mustCallChecks.length === 0) process.on('exit', runCallChecks);

  mustCallChecks.push(context);

  return function() {
    context.actual++;
    return fn.apply(this, arguments);
  };
}

function hasMultiLocalhost() {
  const { internalBinding } = require('internal/test/binding');
  const { TCP, constants: TCPConstants } = internalBinding('tcp_wrap');
  const t = new TCP(TCPConstants.SOCKET);
  const ret = t.bind('127.0.0.2', 0);
  t.close();
  return ret === 0;
}

function skipIfEslintMissing() {
  if (!fs.existsSync(
    path.join(__dirname, '..', '..', 'tools', 'node_modules', 'eslint')
  )) {
    skip('missing ESLint');
  }
}

function canCreateSymLink() {
  // On Windows, creating symlinks requires admin privileges.
  // We'll only try to run symlink test if we have enough privileges.
  // On other platforms, creating symlinks shouldn't need admin privileges
  if (isWindows) {
    // whoami.exe needs to be the one from System32
    // If unix tools are in the path, they can shadow the one we want,
    // so use the full path while executing whoami
    const whoamiPath = path.join(process.env.SystemRoot,
                                 'System32', 'whoami.exe');

    try {
      const output = execSync(`${whoamiPath} /priv`, { timout: 1000 });
      return output.includes('SeCreateSymbolicLinkPrivilege');
    } catch {
      return false;
    }
  }
  // On non-Windows platforms, this always returns `true`
  return true;
}

function getCallSite(top) {
  const originalStackFormatter = Error.prepareStackTrace;
  Error.prepareStackTrace = (err, stack) =>
    `${stack[0].getFileName()}:${stack[0].getLineNumber()}`;
  const err = new Error();
  Error.captureStackTrace(err, top);
  // With the V8 Error API, the stack is not formatted until it is accessed
  err.stack;
  Error.prepareStackTrace = originalStackFormatter;
  return err.stack;
}

function mustNotCall(msg) {
  const callSite = getCallSite(mustNotCall);
  return function mustNotCall() {
    assert.fail(
      `${msg || 'function should not have been called'} at ${callSite}`);
  };
}

function _expectWarning(name, expected, code) {
  if (typeof expected === 'string') {
    expected = [[expected, code]];
  } else if (!Array.isArray(expected)) {
    expected = Object.entries(expected).map(([a, b]) => [b, a]);
  } else if (!(Array.isArray(expected[0]))) {
    expected = [[expected[0], expected[1]]];
  }
  // Deprecation codes are mandatory, everything else is not.
  if (name === 'DeprecationWarning') {
    expected.forEach(([_, code]) => assert(code, expected));
  }
  return mustCall((warning) => {
    const [ message, code ] = expected.shift();
    assert.strictEqual(warning.name, name);
    if (typeof message === 'string') {
      assert.strictEqual(warning.message, message);
    } else {
      assert(message.test(warning.message));
    }
    assert.strictEqual(warning.code, code);
  }, expected.length);
}

let catchWarning;

// Accepts a warning name and description or array of descriptions or a map of
// warning names to description(s) ensures a warning is generated for each
// name/description pair.
// The expected messages have to be unique per `expectWarning()` call.
function expectWarning(nameOrMap, expected, code) {
  if (catchWarning === undefined) {
    catchWarning = {};
    // [browserify] Don't bother actually catching warnings for now as it breaks
    // the tests when catchWarning[warning.name] is undefined for
    // ExperimentalWarning: queueMicrotask() is experimental.
    // process.on('warning', (warning) => catchWarning[warning.name](warning));
  }
  if (typeof nameOrMap === 'string') {
    catchWarning[nameOrMap] = _expectWarning(nameOrMap, expected, code);
  } else {
    Object.keys(nameOrMap).forEach((name) => {
      catchWarning[name] = _expectWarning(name, nameOrMap[name]);
    });
  }
}

class Comparison {
  constructor(obj, keys) {
    for (const key of keys) {
      if (key in obj)
        this[key] = obj[key];
    }
  }
}

// Useful for testing expected internal/error objects
function expectsError(fn, settings, exact) {
  if (typeof fn !== 'function') {
    exact = settings;
    settings = fn;
    fn = undefined;
  }

  function innerFn(error) {
    if (arguments.length !== 1) {
      // Do not use `assert.strictEqual()` to prevent `util.inspect` from
      // always being called.
      assert.fail(`Expected one argument, got ${util.inspect(arguments)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    // The error message should be non-enumerable
    assert.strictEqual(descriptor.enumerable, false);

    let innerSettings = settings;
    if ('type' in settings) {
      const type = settings.type;
      if (type !== Error && !Error.isPrototypeOf(type)) {
        throw new TypeError('`settings.type` must inherit from `Error`');
      }
      let constructor = error.constructor;
      if (constructor.name === 'NodeError' && type.name !== 'NodeError') {
        constructor = Object.getPrototypeOf(error.constructor);
      }
      // Add the `type` to the error to properly compare and visualize it.
      if (!('type' in error))
        error.type = constructor;
    }

    if ('message' in settings &&
        typeof settings.message === 'object' &&
        settings.message.test(error.message)) {
      // Make a copy so we are able to modify the settings.
      innerSettings = Object.create(
        settings, Object.getOwnPropertyDescriptors(settings));
      // Visualize the message as identical in case of other errors.
      innerSettings.message = error.message;
    }

    const isDeepStrictEqual = (actual, expected) => {
      const assert = require('../assert-loader');
      try {
        assert.deepStrictEqual(actual, expected);
        return true;
      } catch(e) {
        return false;
      }
    };

    // Check all error properties.
    const keys = Object.keys(settings);
    for (const key of keys) {
      if (!isDeepStrictEqual(error[key], innerSettings[key])) {
        // Create placeholder objects to create a nice output.
        const a = new Comparison(error, keys);
        const b = new Comparison(innerSettings, keys);

        const tmpLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 0;
        const err = new assert.AssertionError({
          actual: a,
          expected: b,
          operator: 'strictEqual',
          stackStartFn: assert.throws
        });
        Error.stackTraceLimit = tmpLimit;

        throw new assert.AssertionError({
          actual: error,
          expected: settings,
          operator: 'common.expectsError',
          message: err.message
        });
      }

    }
    return true;
  }
  if (fn) {
    assert.throws(fn, innerFn);
    return;
  }
  return mustCall(innerFn, exact);
}

module.exports = {
  mustNotCall,
  mustCall,
  expectWarning,
  expectsError
};
