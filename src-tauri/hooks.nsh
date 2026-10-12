; Installer hooks (bundle.windows.nsis.installerHooks): the install folder goes on the user's PATH,
; so `will-terminal --perfil dev` works from any shell. $$ is a literal $ for PowerShell.

!macro NSIS_HOOK_POSTINSTALL
  ; only once: updates run the installer again
  nsExec::Exec `powershell -NoProfile -Command "$$d = '$INSTDIR'; $$p = [string][Environment]::GetEnvironmentVariable('Path', 'User'); if (($$p -split ';') -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (@($$p -split ';' | Where-Object { $$_ }) + $$d) -join ';', 'User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::Exec `powershell -NoProfile -Command "$$d = '$INSTDIR'; $$p = [string][Environment]::GetEnvironmentVariable('Path', 'User'); [Environment]::SetEnvironmentVariable('Path', (@($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d })) -join ';', 'User')"`
!macroend
