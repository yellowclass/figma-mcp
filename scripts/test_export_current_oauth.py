import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location("exporter",Path(__file__).with_name("export-current-oauth.py"));exporter=importlib.util.module_from_spec(spec);spec.loader.exec_module(exporter)
class ExportTests(unittest.TestCase):
 def store(self):return {"mcpOAuth":{"plugin:figma:figma|hash":{"serverUrl":exporter.URL,"clientId":"id","clientSecret":"secret","refreshToken":"refresh","accessToken":"access"}},"claudeAiOauth":{"accessToken":"never-export"}}
 def test_plugin_export_is_private_and_does_not_copy_access_tokens(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/"private.json";result=exporter.export(self.store(),path,"developer@ivypods.com",verifier=lambda c:{"email":"developer@ivypods.com"});data=json.loads(path.read_text());self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertEqual(set(data),{"accountEmail","clientId","clientSecret","refreshToken"});self.assertNotIn("secret",json.dumps(result));self.assertNotIn("access",data)
   with self.assertRaises(RuntimeError):exporter.export(self.store(),path,"developer@ivypods.com")
 def test_wrong_account_is_not_exported(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/"private.json"
   with self.assertRaises(RuntimeError):exporter.export(self.store(),path,"developer@ivypods.com",verifier=lambda c:{"email":"other@example.com"})
   self.assertFalse(path.exists())
 def test_ambiguity_requires_selection(self):
  store=self.store();store["mcpOAuth"]["figma-remote-mcp|other"]=dict(next(iter(store["mcpOAuth"].values())))
  with self.assertRaises(RuntimeError):exporter.select_entry(store)
  name,_=exporter.select_entry(store,"plugin:figma:figma");self.assertEqual(name,"plugin:figma:figma|hash")
