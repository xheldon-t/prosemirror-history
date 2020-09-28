import RopeSequence from "rope-sequence"
import {Mapping} from "prosemirror-transform"
import {Plugin, PluginKey} from "prosemirror-state"

// ProseMirror's history isn't simply a way to roll back to a previous
// state, because ProseMirror supports applying changes without adding
// them to the history (for example during collaboration).
//
// @cn ProseMirror 的历史并不只是简单的回滚到之前的 state，因为 ProseMirror 支持修改文档而不将它们添加到历史栈中（例如，在协同编辑时）。
//
// To this end, each 'Branch' (one for the undo history and one for
// the redo history) keeps an array of 'Items', which can optionally
// hold a step (an actual undoable change), and always hold a position
// map (which is needed to move changes below them to apply to the
// current document).
//
// @cn 为此，每个 「Branch」（一个用于撤销历史，一个用于重做历史）保存一个「Items」的数组，每个 Item 可选的持有一个 step（一个执行实际撤销操作的修改），
// 并且总是持有一个位置 map（以用来将其后续的修改应用到当前文档中）。
//
// An item that has both a step and a selection bookmark is the start
// of an 'event' — a group of changes that will be undone or redone at
// once. (It stores only the bookmark, since that way we don't have to
// provide a document until the selection is actually applied, which
// is useful when compressing.)
//
// @cn 一个 item 同时有一个 step 和一个选区 bookmark，它是一个「事件」的开始 -- 即一组修改将会被一次性立即撤销或者重做。（它只存储 bookmark），
// 因为这样的话在实际应用选区之前，我们就不需要提供一个文档，这在压缩时非常有用）。

// Used to schedule history compression
const max_empty_items = 500

class Branch {
  constructor(items, eventCount) {
    this.items = items
    this.eventCount = eventCount
  }

  // : (EditorState, bool) → ?{transform: Transform, selection: ?SelectionBookmark, remaining: Branch}
  // Pop the latest event off the branch's history and apply it
  // to a document transform.
  popEvent(state, preserveItems) {
    if (this.eventCount == 0) return null

    let end = this.items.length
    for (;; end--) {
      let next = this.items.get(end - 1)
      if (next.selection) { --end; break }
    }

    let remap, mapFrom
    if (preserveItems) {
      remap = this.remapping(end, this.items.length)
      mapFrom = remap.maps.length
    }
    let transform = state.tr
    let selection, remaining
    let addAfter = [], addBefore = []

    this.items.forEach((item, i) => {
      if (!item.step) {
        if (!remap) {
          remap = this.remapping(end, i + 1)
          mapFrom = remap.maps.length
        }
        mapFrom--
        addBefore.push(item)
        return
      }

      if (remap) {
        addBefore.push(new Item(item.map))
        let step = item.step.map(remap.slice(mapFrom)), map

        if (step && transform.maybeStep(step).doc) {
          map = transform.mapping.maps[transform.mapping.maps.length - 1]
          addAfter.push(new Item(map, null, null, addAfter.length + addBefore.length))
        }
        mapFrom--
        if (map) remap.appendMap(map, mapFrom)
      } else {
        transform.maybeStep(item.step)
      }

      if (item.selection) {
        selection = remap ? item.selection.map(remap.slice(mapFrom)) : item.selection
        remaining = new Branch(this.items.slice(0, end).append(addBefore.reverse().concat(addAfter)), this.eventCount - 1)
        return false
      }
    }, this.items.length, 0)

    return {remaining, transform, selection}
  }

  // : (Transform, ?SelectionBookmark, Object) → Branch
  // Create a new branch with the given transform added.
  addTransform(transform, selection, histOptions, preserveItems) {
    let newItems = [], eventCount = this.eventCount
    let oldItems = this.items, lastItem = !preserveItems && oldItems.length ? oldItems.get(oldItems.length - 1) : null

    for (let i = 0; i < transform.steps.length; i++) {
      let step = transform.steps[i].invert(transform.docs[i])
      let item = new Item(transform.mapping.maps[i], step, selection), merged
      if (merged = lastItem && lastItem.merge(item)) {
        item = merged
        if (i) newItems.pop()
        else oldItems = oldItems.slice(0, oldItems.length - 1)
      }
      newItems.push(item)
      if (selection) {
        eventCount++
        selection = null
      }
      if (!preserveItems) lastItem = item
    }
    let overflow = eventCount - histOptions.depth
    if (overflow > DEPTH_OVERFLOW) {
      oldItems = cutOffEvents(oldItems, overflow)
      eventCount -= overflow
    }
    return new Branch(oldItems.append(newItems), eventCount)
  }

  remapping(from, to) {
    let maps = new Mapping
    this.items.forEach((item, i) => {
      let mirrorPos = item.mirrorOffset != null && i - item.mirrorOffset >= from
          ? maps.maps.length - item.mirrorOffset : null
      maps.appendMap(item.map, mirrorPos)
    }, from, to)
    return maps
  }

  addMaps(array) {
    if (this.eventCount == 0) return this
    return new Branch(this.items.append(array.map(map => new Item(map))), this.eventCount)
  }

  // : (Transform, number)
  // When the collab module receives remote changes, the history has
  // to know about those, so that it can adjust the steps that were
  // rebased on top of the remote changes, and include the position
  // maps for the remote changes in its array of items.
  rebased(rebasedTransform, rebasedCount) {
    if (!this.eventCount) return this

    let rebasedItems = [], start = Math.max(0, this.items.length - rebasedCount)

    let mapping = rebasedTransform.mapping
    let newUntil = rebasedTransform.steps.length
    let eventCount = this.eventCount
    this.items.forEach(item => { if (item.selection) eventCount-- }, start)

    let iRebased = rebasedCount
    this.items.forEach(item => {
      let pos = mapping.getMirror(--iRebased)
      if (pos == null) return
      newUntil = Math.min(newUntil, pos)
      let map = mapping.maps[pos]
      if (item.step) {
        let step = rebasedTransform.steps[pos].invert(rebasedTransform.docs[pos])
        let selection = item.selection && item.selection.map(mapping.slice(iRebased + 1, pos))
        if (selection) eventCount++
        rebasedItems.push(new Item(map, step, selection))
      } else {
        rebasedItems.push(new Item(map))
      }
    }, start)

    let newMaps = []
    for (let i = rebasedCount; i < newUntil; i++)
      newMaps.push(new Item(mapping.maps[i]))
    let items = this.items.slice(0, start).append(newMaps).append(rebasedItems)
    let branch = new Branch(items, eventCount)

    if (branch.emptyItemCount() > max_empty_items)
      branch = branch.compress(this.items.length - rebasedItems.length)
    return branch
  }

  emptyItemCount() {
    let count = 0
    this.items.forEach(item => { if (!item.step) count++ })
    return count
  }

  // Compressing a branch means rewriting it to push the air (map-only
  // items) out. During collaboration, these naturally accumulate
  // because each remote change adds one. The `upto` argument is used
  // to ensure that only the items below a given level are compressed,
  // because `rebased` relies on a clean, untouched set of items in
  // order to associate old items with rebased steps.
  compress(upto = this.items.length) {
    let remap = this.remapping(0, upto), mapFrom = remap.maps.length
    let items = [], events = 0
    this.items.forEach((item, i) => {
      if (i >= upto) {
        items.push(item)
        if (item.selection) events++
      } else if (item.step) {
        let step = item.step.map(remap.slice(mapFrom)), map = step && step.getMap()
        mapFrom--
        if (map) remap.appendMap(map, mapFrom)
        if (step) {
          let selection = item.selection && item.selection.map(remap.slice(mapFrom))
          if (selection) events++
          let newItem = new Item(map.invert(), step, selection), merged, last = items.length - 1
          if (merged = items.length && items[last].merge(newItem))
            items[last] = merged
          else
            items.push(newItem)
        }
      } else if (item.map) {
        mapFrom--
      }
    }, this.items.length, 0)
    return new Branch(RopeSequence.from(items.reverse()), events)
  }
}

Branch.empty = new Branch(RopeSequence.empty, 0)

function cutOffEvents(items, n) {
  let cutPoint
  items.forEach((item, i) => {
    if (item.selection && (n-- == 0)) {
      cutPoint = i
      return false
    }
  })
  return items.slice(cutPoint)
}

class Item {
  constructor(map, step, selection, mirrorOffset) {
    // The (forward) step map for this item.
    this.map = map
    // The inverted step
    this.step = step
    // If this is non-null, this item is the start of a group, and
    // this selection is the starting selection for the group (the one
    // that was active before the first step was applied)
    this.selection = selection
    // If this item is the inverse of a previous mapping on the stack,
    // this points at the inverse's offset
    this.mirrorOffset = mirrorOffset
  }

  merge(other) {
    if (this.step && other.step && !other.selection) {
      let step = other.step.merge(this.step)
      if (step) return new Item(step.getMap().invert(), step, this.selection)
    }
  }
}

// The value of the state field that tracks undo/redo history for that
// state. Will be stored in the plugin state when the history plugin
// is active.
export class HistoryState {
  constructor(done, undone, prevRanges, prevTime) {
    this.done = done
    this.undone = undone
    this.prevRanges = prevRanges
    this.prevTime = prevTime
  }
}

const DEPTH_OVERFLOW = 20

// : (HistoryState, EditorState, Transaction, Object)
// Record a transformation in undo history.
function applyTransaction(history, state, tr, options) {
  let historyTr = tr.getMeta(historyKey), rebased
  if (historyTr) return historyTr.historyState

  if (tr.getMeta(closeHistoryKey)) history = new HistoryState(history.done, history.undone, null, 0)

  let appended = tr.getMeta("appendedTransaction")

  if (tr.steps.length == 0) {
    return history
  } else if (appended && appended.getMeta(historyKey)) {
    if (appended.getMeta(historyKey).redo)
      return new HistoryState(history.done.addTransform(tr, null, options, mustPreserveItems(state)),
                              history.undone, rangesFor(tr.mapping.maps[tr.steps.length - 1]), history.prevTime)
    else
      return new HistoryState(history.done, history.undone.addTransform(tr, null, options, mustPreserveItems(state)),
                              null, history.prevTime)
  } else if (tr.getMeta("addToHistory") !== false && !(appended && appended.getMeta("addToHistory") === false)) {
    // Group transforms that occur in quick succession into one event.
    let newGroup = history.prevTime == 0 || !appended && (history.prevTime < (tr.time || 0) - options.newGroupDelay ||
                                                          !isAdjacentTo(tr, history.prevRanges))
    let prevRanges = appended ? mapRanges(history.prevRanges, tr.mapping) : rangesFor(tr.mapping.maps[tr.steps.length - 1])
    return new HistoryState(history.done.addTransform(tr, newGroup ? state.selection.getBookmark() : null,
                                                      options, mustPreserveItems(state)),
                            Branch.empty, prevRanges, tr.time)
  } else if (rebased = tr.getMeta("rebased")) {
    // Used by the collab module to tell the history that some of its
    // content has been rebased.
    return new HistoryState(history.done.rebased(tr, rebased),
                            history.undone.rebased(tr, rebased),
                            mapRanges(history.prevRanges, tr.mapping), history.prevTime)
  } else {
    return new HistoryState(history.done.addMaps(tr.mapping.maps),
                            history.undone.addMaps(tr.mapping.maps),
                            mapRanges(history.prevRanges, tr.mapping), history.prevTime)
  }
}

function isAdjacentTo(transform, prevRanges) {
  if (!prevRanges) return false
  if (!transform.docChanged) return true
  let adjacent = false
  transform.mapping.maps[0].forEach((start, end) => {
    for (let i = 0; i < prevRanges.length; i += 2)
      if (start <= prevRanges[i + 1] && end >= prevRanges[i])
        adjacent = true
  })
  return adjacent
}

function rangesFor(map) {
  let result = []
  map.forEach((_from, _to, from, to) => result.push(from, to))
  return result
}

function mapRanges(ranges, mapping) {
  if (!ranges) return null
  let result = []
  for (let i = 0; i < ranges.length; i += 2) {
    let from = mapping.map(ranges[i], 1), to = mapping.map(ranges[i + 1], -1)
    if (from <= to) result.push(from, to)
  }
  return result
}

// : (HistoryState, EditorState, (tr: Transaction), bool)
// Apply the latest event from one branch to the document and shift the event
// onto the other branch.
function histTransaction(history, state, dispatch, redo) {
  let preserveItems = mustPreserveItems(state), histOptions = historyKey.get(state).spec.config
  let pop = (redo ? history.undone : history.done).popEvent(state, preserveItems)
  if (!pop) return

  let selection = pop.selection.resolve(pop.transform.doc)
  let added = (redo ? history.done : history.undone).addTransform(pop.transform, state.selection.getBookmark(),
                                                                  histOptions, preserveItems)

  let newHist = new HistoryState(redo ? added : pop.remaining, redo ? pop.remaining : added, null, 0)
  dispatch(pop.transform.setSelection(selection).setMeta(historyKey, {redo, historyState: newHist}).scrollIntoView())
}

let cachedPreserveItems = false, cachedPreserveItemsPlugins = null
// Check whether any plugin in the given state has a
// `historyPreserveItems` property in its spec, in which case we must
// preserve steps exactly as they came in, so that they can be
// rebased.
function mustPreserveItems(state) {
  let plugins = state.plugins
  if (cachedPreserveItemsPlugins != plugins) {
    cachedPreserveItems = false
    cachedPreserveItemsPlugins = plugins
    for (let i = 0; i < plugins.length; i++) if (plugins[i].spec.historyPreserveItems) {
      cachedPreserveItems = true
      break
    }
  }
  return cachedPreserveItems
}

// :: (Transaction) → Transaction
// Set a flag on the given transaction that will prevent further steps
// from being appended to an existing history event (so that they
// require a separate undo command to undo).
//
// @cn 在给定的 transaction 上设置一个标记，这将会阻止接下来的 steps 们被附加到一个已经存在的历史事件中（这样就需要一个单独的撤销命令来撤销了）。
//
// @comment 这个函数不能顾名思义的以为不会会将 tr 加入到历史栈中。正确理解应该是其会将本来能够一个 tr n 个 steps 完成的修改，
// 变成了 两个 tr，n/2 个 step。因此需要额外的撤销命令来撤销修改。「close」表示紧急中断该 tr，然后将剩余的 steps 放到一个新的 tr 中。
export function closeHistory(tr) {
  return tr.setMeta(closeHistoryKey, true)
}

const historyKey = new PluginKey("history")
const closeHistoryKey = new PluginKey("closeHistory")

// :: (?Object) → Plugin
// Returns a plugin that enables the undo history for an editor. The
// plugin will track undo and redo stacks, which can be used with the
// [`undo`](#history.undo) and [`redo`](#history.redo) commands.
//
// @cn 返回一个插件以使编辑器撤销历史可用。该插件将会追踪撤销和重做的操作栈，这可以和 [`撤销`](#history.undo) and [`重做`](#history.redo)
// 命令一同使用。
//
// You can set an `"addToHistory"` [metadata
// property](#state.Transaction.setMeta) of `false` on a transaction
// to prevent it from being rolled back by undo.
//
// @cn 你可以在一个 transaction 上设置一个 `"addToHistory"` 的 [metadata 属性](#state.Transaction.setMeta) 为 `false`，来阻止该
// tr 被撤销回滚。
//
// @comment 设置了这个之后，该 tr 就相当于不会被加入到历史栈中。
//
//   config::-
//   Supports the following configuration options:
//
//   @cn 支持下列的参数可选：
//
//     depth:: ?number
//     The amount of history events that are collected before the
//     oldest events are discarded. Defaults to 100.
//
//     @cn 在最早的操作历史被丢弃之前，历史栈的最大长度，默认是 100。
//
//     @comment 超过了就先丢弃最早的操作记录。
//
//     newGroupDelay:: ?number
//     The delay between changes after which a new group should be
//     started. Defaults to 500 (milliseconds). Note that when changes
//     aren't adjacent, a new group is always started.
//
//     @cn 操作从开始算起应该持续多久才会被算作一个操作。默认是 500（毫秒）。记住，如果多个修改不相邻的话，总是会被算作是新的操作。
//
//     @comment 如果该值被设置为 500，则在 500 毫秒内输入 10 个字，这样会触发 10 个 tr，但是会被归为一「组」，撤销的时候直接撤销这 10 个字的输入记录。
//     如果 500 毫秒内输入 20 个字同理撤销这 20 个字的记录。如果在 500 毫秒内输入了 10 个字，在 501 毫秒内输入了第 11 个字，则撤销的时候，那第 501 毫秒输入的第
//     11 个字被算做是一组，先撤销那 1 个字的输入，再撤销那 10 个字的输入。这个逻辑是为了和系统输入保持一致，各位可以试试在系统的某个界面如搜索框变换输入速度来输入内容后
//     撤销，看会发生什么。
export function history(config) {
  config = {depth: config && config.depth || 100,
            newGroupDelay: config && config.newGroupDelay || 500}
  return new Plugin({
    key: historyKey,

    state: {
      init() {
        return new HistoryState(Branch.empty, Branch.empty, null, 0)
      },
      apply(tr, hist, state) {
        return applyTransaction(hist, state, tr, config)
      }
    },

    config
  })
}

// :: (EditorState, ?(tr: Transaction)) → bool
// A command function that undoes the last change, if any.
//
// @cn 一个可以撤销最后修改（如果有）的命令函数。
export function undo(state, dispatch) {
  let hist = historyKey.getState(state)
  if (!hist || hist.done.eventCount == 0) return false
  if (dispatch) histTransaction(hist, state, dispatch, false)
  return true
}

// :: (EditorState, ?(tr: Transaction)) → bool
// A command function that redoes the last undone change, if any.
//
// @cn 一个可以重做最后一次撤销修改（如果有）的命令函数。
export function redo(state, dispatch) {
  let hist = historyKey.getState(state)
  if (!hist || hist.undone.eventCount == 0) return false
  if (dispatch) histTransaction(hist, state, dispatch, true)
  return true
}

// :: (EditorState) → number
// The amount of undoable events available in a given state.
//
// @cn 在给定的 state 中可以被撤销的操作的数量。
export function undoDepth(state) {
  let hist = historyKey.getState(state)
  return hist ? hist.done.eventCount : 0
}

// :: (EditorState) → number
// The amount of redoable events available in a given editor state.
//
// @cn 在给定的编辑器 state 中可以被重做的操作的数量。
export function redoDepth(state) {
  let hist = historyKey.getState(state)
  return hist ? hist.undone.eventCount : 0
}
