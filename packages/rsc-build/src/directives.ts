import ts from 'typescript';

export interface ModuleInspection {
  useClient: boolean;
  exports: string[];
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

export function inspectModule(source: string, filename: string): ModuleInspection {
  const scriptKind = filename.endsWith('.tsx') || filename.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const parseDiagnostics = (file as ts.SourceFile & {
    parseDiagnostics: readonly ts.DiagnosticWithLocation[];
  }).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`${filename}:${diagnostic.start ?? 0}: ${message}`);
  }

  let useClient = false;
  for (const statement of file.statements) {
    if (
      ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
    ) {
      if (statement.expression.text === 'use client') useClient = true;
      continue;
    }
    break;
  }

  const exports: string[] = [];
  const add = (name: string) => {
    if (!exports.includes(name)) exports.push(name);
  };
  for (const statement of file.statements) {
    const hasDefault = ts.canHaveModifiers(statement)
      && (ts.getModifiers(statement)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      ) ?? false);
    if (hasDefault && isExported(statement)) add('default');

    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && isExported(statement)
      && !hasDefault
      && statement.name
    ) {
      add(statement.name.text);
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) add(name);
      }
    } else if (ts.isExportAssignment(statement)) {
      add('default');
    } else if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        if (useClient) {
          throw new Error(`${filename}: export * is unsupported in a 'use client' entry`);
        }
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) add(element.name.text);
      }
    }
  }

  if (useClient && exports.length === 0) {
    throw new Error(`${filename}: a 'use client' entry must export at least one value`);
  }
  return { useClient, exports };
}
