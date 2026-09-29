/**
 * 可安装应用的静态件：清单字段齐全、图标文件真实存在且尺寸与声明一致、入口页引了清单。
 * Chrome 的安装条件里 192 与 512 两个尺寸缺一不可；公网入口有 Basic 登录，清单必须带凭据去取。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pngSize = (file: string) => {
  const b = readFileSync(file)
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${file} 不是 PNG`)
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
}

test('可安装应用：清单字段齐全，图标尺寸与声明一致，192/512 与可裁切版都有；入口页带凭据引清单', () => {
  const manifest = JSON.parse(readFileSync(path.join(web, 'public/manifest.webmanifest'), 'utf8'))
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) assert.ok(manifest[key], `清单缺 ${key}`)
  assert.equal(manifest.display, 'standalone')
  const icons: { src: string; sizes: string; purpose: string }[] = manifest.icons
  for (const icon of icons) assert.equal(pngSize(path.join(web, 'public', icon.src)), icon.sizes, `${icon.src} 的实际尺寸和声明不一致`)
  for (const size of ['192x192', '512x512']) {
    assert.ok(icons.some(i => i.sizes === size && i.purpose === 'any'), `缺 ${size} 普通图标`)
    assert.ok(icons.some(i => i.sizes === size && i.purpose === 'maskable'), `缺 ${size} 可裁切图标`)
  }
  const html = readFileSync(path.join(web, 'index.html'), 'utf8')
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/)
  assert.match(readFileSync(path.join(web, 'public/sw.js'), 'utf8'), /\/assets\//, 'service worker 只碰静态资源')
})
