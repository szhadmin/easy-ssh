; ============================================================
;  EasySSH 自定义 NSIS 脚本
;  - 卸载时可选是否一并清除本地连接配置与凭据
;  - 安装完成后写入防火墙提示（可选）
; ============================================================

!macro customUnInstall
  ; 询问用户是否保留连接配置（默认保留，避免误删）
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除已保存的连接配置与加密凭据？$\r$\n$\r$\n选择「否」将保留，重新安装后可直接继续使用。" \
    /SD IDNO IDYES purge IDNO keep

  purge:
    RMDir /r "$APPDATA\EasySSH"
    Goto done

  keep:
    DetailPrint "保留用户配置目录: $APPDATA\EasySSH"

  done:
!macroend

!macro customInstall
  DetailPrint "EasySSH 安装完成，桌面快捷方式已创建。"
!macroend
