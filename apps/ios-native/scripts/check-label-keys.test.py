import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('check', Path(__file__).with_name('check-label-keys.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

screen = 'Text(model.label("a.loaded")); Text(model.label(flag ? "a.shown" : "a.hidden"))'
assert check.label_keys(screen) == {'a.loaded', 'a.shown', 'a.hidden'}
model = 'let keys = ["a.loaded"]; Text(label("a.only"))'
assert check.requested_keys(model, ['static let stringKeys = ["a.shown"]']) == {'a.loaded', 'a.shown'}
assert check.unloaded() == {}
print('check-label-keys ok')
