// Запуск утилит из TypeScript-исходников стенда без сборки: `node --import ./tsLoader.mjs file.ts`.
// Встроенное стирание типов Node не умеет свойства-параметры конструктора и не ведёт импорт `./x.js` на `./x.ts`,
// поэтому исходник переводит компилятор TypeScript, а импорт `.js` ищет рядом файл `.ts`.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TS_EXTENSION = '.ts';
const JS_EXTENSION = /\.js$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelativeJsFromTs =
      specifier.startsWith('.') && JS_EXTENSION.test(specifier) && context.parentURL?.endsWith(TS_EXTENSION) === true;
    if (!isRelativeJsFromTs) {
      return nextResolve(specifier, context);
    }
    const url = new URL(specifier.replace(JS_EXTENSION, TS_EXTENSION), context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      return nextResolve(specifier, context);
    }
    return { url: url.href, format: 'module', shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(TS_EXTENSION)) {
      return nextLoad(url, context);
    }
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  },
});
