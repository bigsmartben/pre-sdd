import 'package:flutter/widgets.dart';
import '../pages/home_page.dart';

abstract final class AppRoutes {
  static const home = '/';
  static final Map<String, WidgetBuilder> routes = {home: (_) => const HomePage()};
}
