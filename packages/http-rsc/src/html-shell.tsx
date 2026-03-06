import React, { PropsWithChildren } from 'react';

export function HtmlShell(props: PropsWithChildren<{
  title?: string,
  scripts?: string[],
  styles?: string[],
  links?: string[],
}>) {
  return (
    <html>
      <head>
        <title>{props.title}</title>
        {props.links?.map(link => <link key={link} rel="stylesheet" href={link} />)}
        {props.styles?.map(style => <style key={style} dangerouslySetInnerHTML={{ __html: style }} />)}
        {props.scripts?.map(script => <script key={script} src={script} />)}
      </head>
      <body>
        <div id="root">{props.children}</div>
      </body>
    </html>
  )
}