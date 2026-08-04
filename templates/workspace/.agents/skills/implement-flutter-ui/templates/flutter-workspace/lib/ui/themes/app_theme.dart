import 'package:flutter/material.dart';
import '../tokens/app_tokens.dart';

abstract final class AppTheme {
  static final ThemeData light = ThemeData(colorSchemeSeed: AppTokens.seedColor);
}
