' Double-click entry point: starts the codexm console tray with no visible window.
' Feedback (a "starting" notice, failures, the tray balloon) comes from
' start-tray.ps1: this file has no BOM and WSH decodes it as ANSI, so Chinese
' text here would turn into mojibake on a zh-CN box.
Option Explicit

Dim shell, folder, command
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & folder & "\start-tray.ps1"""
shell.Run command, 0, False

