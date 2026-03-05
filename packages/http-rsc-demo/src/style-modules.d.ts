declare module '*.module.less' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.less' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}
