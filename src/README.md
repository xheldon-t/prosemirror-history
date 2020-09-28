An implementation of an undo/redo history for ProseMirror. This
history is _selective_, meaning it does not just roll back to a
previous state but can undo some changes while keeping other, later
changes intact. (This is necessary for collaborative editing, and
comes up in other situations as well.)

@cn 一个 ProseMirror 的撤销/重做历史的实现。撤销/重做的历史是 _可选择的_，这意味着它不仅仅是回滚到
之前的 state，而是可以在撤销部分修改的同时保留其他的修改，或者原封不动的保留之后的修改（这对于协同编辑来说
是很有必要的，在其他一些情况下也可能会发生）。

@history

@undo

@redo

@undoDepth

@redoDepth

@closeHistory
