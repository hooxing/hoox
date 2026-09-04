import { IncrementalMarkdownParser, type PositionedBlock } from "@hoox/vendor-deepseek-markdown";
import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const grammar = unified().use(remarkParse).use(remarkGfm);
export function parseMarkdown(text: string): Root {
  return grammar.parse(text);
}

function hasGlobalReferences(node: {
  readonly type: string;
  readonly children?: readonly unknown[];
}): boolean {
  if (
    [
      "definition",
      "footnoteDefinition",
      "footnoteReference",
      "linkReference",
      "imageReference",
    ].includes(node.type)
  )
    return true;
  return node.children?.some((child) => hasGlobalReferences(child as RootContent)) ?? false;
}

/** 跨块引用需要全文语义；检测到后使用完整文档路径，避免冻结前缀改变链接或脚注。 */
export class MarkdownStream {
  private readonly parser = new IncrementalMarkdownParser(parseMarkdown);
  private globalReferences = false;
  private previous = "";
  private checkedFrozen = 0;

  update(text: string, streaming: boolean): readonly PositionedBlock[] | undefined {
    if (!text.startsWith(this.previous)) {
      this.globalReferences = false;
      this.checkedFrozen = 0;
    }
    this.previous = text;
    if (!streaming) {
      const root = parseMarkdown(text);
      return hasGlobalReferences(root)
        ? undefined
        : root.children.map((node, index) => ({ node, key: node.position?.start.offset ?? index }));
    }
    if (this.globalReferences) return undefined;
    const frame = this.parser.update(text);
    this.globalReferences = [...frame.frozen.slice(this.checkedFrozen), ...frame.tail].some(
      (block) => hasGlobalReferences(block.node),
    );
    this.checkedFrozen = frame.frozen.length;
    return this.globalReferences ? undefined : [...frame.frozen, ...frame.tail];
  }
}
