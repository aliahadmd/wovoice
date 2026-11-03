import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyContext, restrictContext, parseContext } from '../../worker/src/context'
import { DictationSession } from '../src/main/dictation-session'

test('Mac app and field policy matches Android without assuming relationship', () => {
  for (const appId of [
    'com.whatsapp',
    'net.whatsapp.WhatsApp',
    'ru.keepcoder.Telegram',
    'ph.telegra.Telegraph',
    'com.facebook.orca',
    'com.tencent.xinwechat'
  ]) {
    const context = classifyContext({ appId, level: 'app', before: 'Dear Professor Khan' })!
    assert.equal(context.purpose, 'chat')
    assert.equal(context.audience, 'unknown')
    assert.equal(context.before, undefined)
  }
  assert.equal(
    classifyContext({ appId: 'com.apple.mail', hint: 'Message', level: 'app' })?.purpose,
    'email'
  )
  assert.equal(
    classifyContext({ appId: 'com.apple.mail', hint: 'Subject', level: 'app' })?.purpose,
    'subject'
  )
  assert.equal(classifyContext({ appId: 'com.apple.Notes', level: 'app' })?.purpose, 'notes')
  assert.equal(classifyContext({ appId: 'com.apple.Terminal', level: 'app' })?.purpose, 'code')
  const nearby = classifyContext({
    appId: 'com.apple.mail',
    level: 'nearby',
    before: 'Dear Professor Khan, '
  })!
  assert.equal(nearby.audience, 'academic')
  assert.equal(restrictContext(nearby, 'app')?.audience, 'unknown')
  assert.equal(restrictContext(nearby, 'app')?.before, undefined)
  assert.equal(restrictContext(nearby, 'off'), undefined)
  assert.doesNotThrow(() => parseContext(nearby))
})

test('audio and late results are bound to a single recording and account', () => {
  const guard = new DictationSession()
  const first = guard.begin('account-a')
  assert.equal(guard.claim(first, 'account-b'), false)
  assert.equal(guard.claim(first, 'account-a'), true)
  assert.equal(guard.claim(first, 'account-a'), false)
  guard.invalidate()
  assert.equal(guard.active(first, 'account-a'), false)
  const next = guard.begin('account-a')
  assert.equal(guard.claim(first, 'account-a'), false)
  assert.equal(guard.active(next, 'account-b'), false)
  assert.equal(guard.claim(next, 'account-a'), true)
})
