/** 顶栏品牌位：logo + 标题。logo 常显（移动端文字让位时它就是身份标识）。 */
export function Brand() {
  return (
    <span className="brand">
      <img className="brand-logo" src="/logo-64.png" alt="TaleForge" />
      <span className="brand-text">TALEFORGE</span>
    </span>
  )
}
