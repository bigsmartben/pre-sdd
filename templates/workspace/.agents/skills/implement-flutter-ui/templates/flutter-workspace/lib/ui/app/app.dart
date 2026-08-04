import 'package:flutter/material.dart';
import '../routes/app_routes.dart';
import '../themes/app_theme.dart';

class UiSpecApp extends StatelessWidget {
  const UiSpecApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'UI Spec Preview',
        theme: AppTheme.light,
        routes: AppRoutes.routes,
        initialRoute: AppRoutes.home,
      );
}
