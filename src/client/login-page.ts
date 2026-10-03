/** 收到宿主授权地址后才打开页面；浏览器拦截不应中断登录，界面始终保留手动链接。 */
export function openLoginPage(authUrl: string): void {
  if (typeof window === 'undefined') return
  try {
    // 授权页不持有设置页引用，也不接收设置页来源地址。
    // 使用 noopener 时成功打开也可能返回 null，因此不据此判断弹窗是否被拦截。
    window.open(authUrl, '_blank', 'noopener,noreferrer')
  } catch { /* 自动打开失败时仍可通过手动链接完成授权。 */ }
}
