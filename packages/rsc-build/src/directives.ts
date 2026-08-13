import ts from 'typescript';

export interface ModuleInspection {
  useClient: boolean;
  useServer: boolean;
  exports: string[];
}

export interface ModuleDirectives {
  useClient: boolean;
  useServer: boolean;
}

function parseSource(source: string, filename: string): ts.SourceFile {
  const scriptKind = filename.endsWith('.tsx') || filename.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (file as ts.SourceFile & {
    parseDiagnostics: readonly ts.DiagnosticWithLocation[];
  }).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`${filename}:${diagnostic.start ?? 0}: ${message}`);
  }
  return file;
}

export function inspectModuleDirectives(source: string, filename: string): ModuleDirectives {
  const file = parseSource(source, filename);
  return {
    useClient: hasDirective(file.statements, 'use client'),
    useServer: hasDirective(file.statements, 'use server'),
  };
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function isAsync(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
}

function hasDirective(statements: readonly ts.Statement[], directive: string): boolean {
  for (const statement of statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      if (statement.expression.text === directive) return true;
      continue;
    }
    break;
  }
  return false;
}

function containsInlineServerDirective(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node))
      && node.body
      && ts.isBlock(node.body)
      && hasDirective(node.body.statements, 'use server')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

export function inspectModule(source: string, filename: string): ModuleInspection {
  const file = parseSource(source, filename);

  let useClient = false;
  let useServer = false;
  for (const statement of file.statements) {
    if (
      ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
    ) {
      if (statement.expression.text === 'use client') useClient = true;
      if (statement.expression.text === 'use server') useServer = true;
      continue;
    }
    break;
  }
  if (useClient && useServer) {
    throw new Error(`${filename}: a module cannot declare both 'use client' and 'use server'`);
  }
  if (!useServer && containsInlineServerDirective(file)) {
    throw new Error(`${filename}: inline 'use server' functions are unsupported; export an async function from a 'use server' module`);
  }

  const exports: string[] = [];
  const localAsyncFunctions = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isAsync(statement)) {
      localAsyncFunctions.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name)
          && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          && isAsync(declaration.initializer)
        ) {
          localAsyncFunctions.add(declaration.name.text);
        }
      }
    }
  }
  const add = (name: string) => {
    if (!exports.includes(name)) exports.push(name);
  };
  for (const statement of file.statements) {
    const hasDefault = ts.canHaveModifiers(statement)
      && (ts.getModifiers(statement)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      ) ?? false);
    if (hasDefault && isExported(statement)) add('default');

    if (useServer && hasDefault && isExported(statement)) {
      if (!ts.isFunctionDeclaration(statement) || !isAsync(statement)) {
        throw new Error(`${filename}: every 'use server' export must be an async function`);
      }
    }

    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && isExported(statement)
      && !hasDefault
      && statement.name
    ) {
      if (useServer && (!ts.isFunctionDeclaration(statement) || !isAsync(statement))) {
        throw new Error(`${filename}: every 'use server' export must be an async function`);
      }
      add(statement.name.text);
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (useServer) {
          if (!ts.isIdentifier(declaration.name) || !localAsyncFunctions.has(declaration.name.text)) {
            throw new Error(`${filename}: every 'use server' export must be an async function`);
          }
        }
        for (const name of bindingNames(declaration.name)) add(name);
      }
    } else if (ts.isExportAssignment(statement)) {
      if (
        useServer
        && (!ts.isArrowFunction(statement.expression)
          && !ts.isFunctionExpression(statement.expression)
          && !(ts.isIdentifier(statement.expression) && localAsyncFunctions.has(statement.expression.text)))
      ) {
        throw new Error(`${filename}: every 'use server' export must be an async function`);
      }
      if (
        useServer
        && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))
        && !isAsync(statement.expression)
      ) {
        throw new Error(`${filename}: every 'use server' export must be an async function`);
      }
      add('default');
    } else if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        if (useClient || useServer) {
          throw new Error(`${filename}: export * is unsupported in a directive entry`);
        }
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        if (useServer && statement.moduleSpecifier) {
          throw new Error(`${filename}: a 'use server' re-export is unsupported; export a local async function`);
        }
        for (const element of statement.exportClause.elements) add(element.name.text);
        if (useServer) {
          for (const element of statement.exportClause.elements) {
            if (!localAsyncFunctions.has(element.propertyName?.text ?? element.name.text)) {
              throw new Error(`${filename}: every 'use server' export must be an async function`);
            }
          }
        }
      }
    }
  }

  if ((useClient || useServer) && exports.length === 0) {
    throw new Error(`${filename}: a directive entry must export at least one value`);
  }
  return { useClient, useServer, exports };
}
