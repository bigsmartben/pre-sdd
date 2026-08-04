import 'package:flutter_test/flutter_test.dart';
import 'package:pre_sdd_ui/ui/app/app.dart';

void main() {
  testWidgets('shared UI source starts', (tester) async {
    await tester.pumpWidget(const UiSpecApp());
    expect(find.text('Implement the authorized Visual Spec here.'), findsOneWidget);
  });
}
