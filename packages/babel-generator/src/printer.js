/* eslint max-len: 0 */

import repeat from "lodash/repeat";
import Buffer from "./buffer";
import * as n from "./node";
import * as t from "babel-types";

export default class Printer {
  constructor(format, map) {
    this._format = format || {};
    this._buf = new Buffer(map);
    this.insideAux = false;
    this.printAuxAfterOnNextUserNode = false;
    this._printStack = [];
    this.printedCommentStarts = {};
    this.parenPushNewlineState = null;
    this._indent = 0;
  }

  printedCommentStarts: Object;
  parenPushNewlineState: ?Object;

  /**
   * Get the current indent.
   */

  _getIndent(): string {
    if (this._format.compact || this._format.concise) {
      return "";
    } else {
      return repeat(this._format.indent.style, this._indent);
    }
  }

  /**
   * Increment indent size.
   */

  indent(): void {
    this._indent++;
  }

  /**
   * Decrement indent size.
   */

  dedent(): void {
    this._indent--;
  }

  /**
   * Add a semicolon to the buffer.
   */

  semicolon(): void {
    this._append(";", true /* queue */);
  }

  /**
   * Add a right brace to the buffer.
   */

  rightBrace(): void {
    if (!this.endsWith("\n")) this.newline();

    if (this._format.minified && !this._lastPrintedIsEmptyStatement) {
      this._buf.removeLastSemicolon();
    }
    this.token("}");
  }

  /**
   * Add a keyword to the buffer.
   */

  keyword(name: string): void {
    this.word(name);
    this.space();
  }

  /**
   * Add a space to the buffer unless it is compact.
   */

  space(force: boolean = false): void {
    if (this._format.compact) return;

    if ((this._buf.hasContent() && !this.endsWith(" ") && !this.endsWith("\n")) || force) {
      this._space();
    }
  }

  /**
   * Writes a token that can't be safely parsed without taking whitespace into account.
   */

  word(str: string): void {
    if (this._endsWithWord) this._space();

    this._append(str);

    this._endsWithWord = true;
  }

  /**
   * Writes a simple token.
   */

  token(str: string): void {
    const last = this._buf.getLast();
    // space is mandatory to avoid outputting <!--
    // http://javascript.spec.whatwg.org/#comment-syntax
    if ((str === "--" && last === "!") ||

      // Need spaces for operators of the same kind to avoid: `a+++b`
      (str[0] === "+" && last === "+") ||
      (str[0] === "-" && last === "-")) {
      this._space();
    }

    this._append(str);
  }

  /**
   * Add a newline (or many newlines), maintaining formatting.
   */

  newline(i?: number): void {
    if (this._format.retainLines || this._format.compact) return;

    if (this._format.concise) {
      this.space();
      return;
    }

    // never allow more than two lines
    if (this.endsWith("\n\n")) return;

    if (typeof i !== "number") i = 1;

    i = Math.min(2, i);
    if (this.endsWith("{\n") || this.endsWith(":\n")) i--;
    if (i <= 0) return;

    this._buf.removeTrailingSpaces();
    for (let j = 0; j < i; j++) {
      this._newline();
    }
  }

  endsWith(str: string): boolean {
    return this._buf.endsWith(str);
  }

  removeTrailingNewline(): void {
    this._buf.removeTrailingNewline();
  }

  source(prop: string, loc: Object): void {
    this._catchUp(prop, loc);

    this._buf.source(prop, loc);
  }

  withSource(prop: string, loc: Object, cb: () => void): void {
    this._catchUp(prop, loc);

    this._buf.withSource(prop, loc, cb);
  }

  _space(): void {
    this._append(" ", true /* queue */);
  }

  _newline(): void {
    this._append("\n", true /* queue */);
  }

  _append(str: string, queue: boolean = false) {
    this._maybeAddParen(str);
    this._maybeIndent(str);

    if (queue) this._buf.queue(str);
    else this._buf.append(str);

    this._endsWithWord = false;
  }

  _maybeIndent(str: string): void {
    // we've got a newline before us so prepend on the indentation
    if (!this._format.compact && this._indent && this.endsWith("\n") && str[0] !== "\n") {
      this._buf.queue(this._getIndent());
    }
  }

  _maybeAddParen(str: string): void {
    // see startTerminatorless() instance method
    let parenPushNewlineState = this.parenPushNewlineState;
    if (!parenPushNewlineState) return;
    this.parenPushNewlineState = null;

    let i;
    for (i = 0; i < str.length && str[i] === " "; i++) continue;
    if (i === str.length) return;

    const cha = str[i];
    if (cha === "\n" || cha === "/") {
      // we're going to break this terminator expression so we need to add a parentheses
      this.token("(");
      this.indent();
      parenPushNewlineState.printed = true;
    }
  }

  _catchUp(prop: string, loc: Object) {
    if (!this._format.retainLines) return;

    // catch up to this nodes newline if we're behind
    const pos = loc ? loc[prop] : null;
    if (pos && pos.line !== null) {
      while (this._buf.getCurrentLine() < pos.line) {
        this._newline();
      }
    }
  }

  /**
   * Set some state that will be modified if a newline has been inserted before any
   * non-space characters.
   *
   * This is to prevent breaking semantics for terminatorless separator nodes. eg:
   *
   *    return foo;
   *
   * returns `foo`. But if we do:
   *
   *   return
   *   foo;
   *
   *  `undefined` will be returned and not `foo` due to the terminator.
   */

  startTerminatorless(): Object {
    return this.parenPushNewlineState = {
      printed: false
    };
  }

  /**
   * Print an ending parentheses if a starting one has been printed.
   */

  endTerminatorless(state: Object) {
    if (state.printed) {
      this.dedent();
      this.newline();
      this.token(")");
    }
  }

  print(node, parent, opts = {}) {
    if (!node) return;

    this._lastPrintedIsEmptyStatement = false;

    if (parent && parent._compact) {
      node._compact = true;
    }

    let oldInAux = this.insideAux;
    this.insideAux = !node.loc;

    let oldConcise = this._format.concise;
    if (node._compact) {
      this._format.concise = true;
    }

    let printMethod = this[node.type];
    if (!printMethod) {
      throw new ReferenceError(`unknown node of type ${JSON.stringify(node.type)} with constructor ${JSON.stringify(node && node.constructor.name)}`);
    }

    this._printStack.push(node);

    if (node.loc) this.printAuxAfterComment();
    this.printAuxBeforeComment(oldInAux);

    let needsParens = n.needsParens(node, parent, this._printStack);
    if (needsParens) this.token("(");

    this.printLeadingComments(node, parent);

    this._printNewline(true, node, parent, opts);

    if (opts.before) opts.before();

    let loc = (t.isProgram(node) || t.isFile(node)) ? null : node.loc;
    this.withSource("start", loc, () => {
      this[node.type](node, parent);
    });

    // Check again if any of our children may have left an aux comment on the stack
    if (node.loc) this.printAuxAfterComment();

    this.printTrailingComments(node, parent);

    if (needsParens) this.token(")");

    // end
    this._printStack.pop();
    if (opts.after) opts.after();

    this._format.concise = oldConcise;
    this.insideAux = oldInAux;

    this._printNewline(false, node, parent, opts);
  }

  printAuxBeforeComment(wasInAux) {
    let comment = this._format.auxiliaryCommentBefore;
    if (!wasInAux && this.insideAux && !this.printAuxAfterOnNextUserNode) {
      this.printAuxAfterOnNextUserNode = true;
      if (comment) this.printComment({
        type: "CommentBlock",
        value: comment
      });
    }
  }

  printAuxAfterComment() {
    if (this.printAuxAfterOnNextUserNode) {
      this.printAuxAfterOnNextUserNode = false;
      let comment = this._format.auxiliaryCommentAfter;
      if (comment) this.printComment({
        type: "CommentBlock",
        value: comment
      });
    }
  }

  getPossibleRaw(node) {
    if (this._format.minified) return;

    let extra = node.extra;
    if (extra && extra.raw != null && extra.rawValue != null && node.value === extra.rawValue) {
      return extra.raw;
    }
  }

  printJoin(nodes: ?Array, parent: Object, opts = {}) {
    if (!nodes || !nodes.length) return;

    let len = nodes.length;
    let node, i;

    if (opts.indent) this.indent();

    let printOpts = {
      statement: opts.statement,
      addNewlines: opts.addNewlines,
      after: () => {
        if (opts.iterator) {
          opts.iterator(node, i);
        }

        if (opts.separator && parent.loc) {
          this.printAuxAfterComment();
        }

        if (opts.separator && i < len - 1) {
          opts.separator.call(this);
        }
      }
    };

    for (i = 0; i < nodes.length; i++) {
      node = nodes[i];
      this.print(node, parent, printOpts);
    }

    if (opts.indent) this.dedent();
  }

  printAndIndentOnComments(node, parent) {
    let indent = !!node.leadingComments;
    if (indent) this.indent();
    this.print(node, parent);
    if (indent) this.dedent();
  }

  printBlock(parent) {
    let node = parent.body;

    if (!t.isEmptyStatement(node)) {
      this.space();
    }

    this.print(node, parent);
  }

  generateComment(comment) {
    let val = comment.value;
    if (comment.type === "CommentLine") {
      val = `//${val}`;
    } else {
      val = `/*${val}*/`;
    }
    return val;
  }

  printTrailingComments(node, parent) {
    this.printComments(this.getComments(false, node, parent));
  }

  printLeadingComments(node, parent) {
    this.printComments(this.getComments(true, node, parent));
  }

  printInnerComments(node, indent = true) {
    if (!node.innerComments) return;
    if (indent) this.indent();
    this.printComments(node.innerComments);
    if (indent) this.dedent();
  }

  printSequence(nodes, parent, opts = {}) {
    opts.statement = true;
    return this.printJoin(nodes, parent, opts);
  }

  printList(items, parent, opts = {}) {
    if (opts.separator == null) {
      opts.separator = commaSeparator;
    }

    return this.printJoin(items, parent, opts);
  }

  _printNewline(leading, node, parent, opts) {
    // Fast path since 'this.newline' does nothing when not tracking lines.
    if (this._format.retainLines || this._format.compact) return;

    if (!opts.statement && !n.isUserWhitespacable(node, parent)) {
      return;
    }

    // Fast path for concise since 'this.newline' just inserts a space when
    // concise formatting is in use.
    if (this._format.concise) {
      this.space();
      return;
    }

    let lines = 0;

    if (node.start != null && !node._ignoreUserWhitespace && this.tokens.length) {
      // user node
      if (leading) {
        lines = this.whitespace.getNewlinesBefore(node);
      } else {
        lines = this.whitespace.getNewlinesAfter(node);
      }
    } else {
      // generated node
      if (!leading) lines++; // always include at least a single line after
      if (opts.addNewlines) lines += opts.addNewlines(leading, node) || 0;

      let needs = n.needsWhitespaceAfter;
      if (leading) needs = n.needsWhitespaceBefore;
      if (needs(node, parent)) lines++;

      // generated nodes can't add starting file whitespace
      if (!this._buf.hasContent()) lines = 0;
    }

    this.newline(lines);
  }

  getComments(leading, node) {
    // Note, we use a boolean flag here instead of passing in the attribute name as it is faster
    // because this is called extremely frequently.
    return (node && (leading ? node.leadingComments : node.trailingComments)) || [];
  }

  shouldPrintComment(comment) {
    if (this._format.shouldPrintComment) {
      return this._format.shouldPrintComment(comment.value);
    } else {
      if (!this._format.minified &&
          (comment.value.indexOf("@license") >= 0 || comment.value.indexOf("@preserve") >= 0)) {
        return true;
      } else {
        return this._format.comments;
      }
    }
  }

  printComment(comment) {
    if (!this.shouldPrintComment(comment)) return;

    if (comment.ignore) return;
    comment.ignore = true;

    if (comment.start != null) {
      if (this.printedCommentStarts[comment.start]) return;
      this.printedCommentStarts[comment.start] = true;
    }

    // Exclude comments from source mappings since they will only clutter things.
    this.withSource("start", comment.loc, () => {
      // whitespace before
      this.newline(this.whitespace.getNewlinesBefore(comment));

      if (!this.endsWith("[") && !this.endsWith("{")) this.space();

      let val    = this.generateComment(comment);

      //
      if (comment.type === "CommentBlock" && this._format.indent.adjustMultilineComment) {
        let offset = comment.loc && comment.loc.start.column;
        if (offset) {
          let newlineRegex = new RegExp("\\n\\s{1," + offset + "}", "g");
          val = val.replace(newlineRegex, "\n");
        }

        let indentSize = Math.max(this._getIndent().length, this._buf.getCurrentColumn());
        val = val.replace(/\n(?!$)/g, `\n${repeat(" ", indentSize)}`);
      }

      // force a newline for line comments when retainLines is set in case the next printed node
      // doesn't catch up
      if ((this._format.compact || this._format.concise || this._format.retainLines) &&
          comment.type === "CommentLine") {
        val += "\n";
      }

      //
      this.token(val);

      // whitespace after
      this.newline(this.whitespace.getNewlinesAfter(comment));
    });
  }

  printComments(comments?: Array<Object>) {
    if (!comments || !comments.length) return;

    for (let comment of comments) {
      this.printComment(comment);
    }
  }
}

function commaSeparator() {
  this.token(",");
  this.space();
}

for (let generator of [
  require("./generators/template-literals"),
  require("./generators/expressions"),
  require("./generators/statements"),
  require("./generators/classes"),
  require("./generators/methods"),
  require("./generators/modules"),
  require("./generators/types"),
  require("./generators/flow"),
  require("./generators/base"),
  require("./generators/jsx")
]) {
  Object.assign(Printer.prototype, generator);
}
