import React from 'react'
import assert from 'node:assert/strict'

// Component-contract substitute for DSH's built-in renderer. This tests the
// integration and labels, not a second implementation of Markdown parsing.
export function MarkdownText({text,labels}) {
  assert.equal(labels.code.copyLabel,'复制')
  assert.equal(labels.footnotes,'脚注')
  return React.createElement('div',{'data-native-markdown':true},text)
}
