' susurroLive dev launcher: double-click to open the current build without a console.
Option Explicit

Dim shell, fso, root, exe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Electron is not installed." & vbCrLf & vbCrLf & _
         "Run: npm install", vbExclamation, "susurroLive"
  WScript.Quit 1
End If

shell.CurrentDirectory = root
shell.Run """" & exe & """ .", 1, False
