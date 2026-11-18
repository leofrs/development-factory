import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target={props.href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer" />,
  img: ({ node: _node, ...props }) => <img {...props} loading="lazy" decoding="async" />,
  table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="Tabela da revisão" tabIndex={0}><table>{children}</table></div>,
};
const plugins = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return <article className="markdown-content">
    <Markdown remarkPlugins={plugins} components={components} skipHtml>{content}</Markdown>
  </article>;
});
